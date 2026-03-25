/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OBSIDIAN_PERSONAL_VAULT_API_KEY',
    'OPENAI_API_KEY',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // ── Obsidian Local REST API proxy ──
        // Routes /obsidian/* to the local Obsidian REST API, injecting the
        // Bearer token so the container never sees the API key.
        if (req.url?.startsWith('/obsidian/')) {
          const obsidianPath = req.url.slice('/obsidian'.length); // keeps leading /
          const obsidianHeaders: Record<string, string | number> = {
            'content-type':
              (req.headers['content-type'] as string) || 'text/markdown',
            'content-length': body.length,
          };
          if (secrets.OBSIDIAN_PERSONAL_VAULT_API_KEY) {
            obsidianHeaders['authorization'] =
              `Bearer ${secrets.OBSIDIAN_PERSONAL_VAULT_API_KEY}`;
          }

          const obsidianReq = httpsRequest(
            {
              hostname: '127.0.0.1',
              port: 27124,
              path: obsidianPath,
              method: req.method,
              headers: obsidianHeaders,
              rejectUnauthorized: false, // self-signed cert
            },
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          obsidianReq.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Obsidian proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Obsidian unavailable');
            }
          });

          obsidianReq.write(body);
          obsidianReq.end();
          return;
        }

        // ── OpenAI API proxy ──
        // Routes /openai/* to the OpenAI API, injecting the Bearer token
        // so the container never sees the API key.
        if (req.url?.startsWith('/openai/')) {
          const openaiPath = req.url.slice('/openai'.length); // keeps leading /
          const openaiHeaders: Record<string, string | number | string[]> = {
            ...(req.headers as Record<string, string>),
            host: 'api.openai.com',
            'content-length': body.length,
          };
          delete openaiHeaders['connection'];
          delete openaiHeaders['keep-alive'];
          delete openaiHeaders['transfer-encoding'];

          if (secrets.OPENAI_API_KEY) {
            openaiHeaders['authorization'] =
              `Bearer ${secrets.OPENAI_API_KEY}`;
          }

          const openaiReq = httpsRequest(
            {
              hostname: 'api.openai.com',
              port: 443,
              path: openaiPath,
              method: req.method,
              headers: openaiHeaders,
            },
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          openaiReq.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'OpenAI proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('OpenAI unavailable');
            }
          });

          openaiReq.write(body);
          openaiReq.end();
          return;
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
