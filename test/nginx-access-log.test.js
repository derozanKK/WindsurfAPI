// SEC-02 (audit 2026-10-22): the bundled nginx.conf set no `access_log`, so
// nginx used the default `combined` format and logged `$request_uri` verbatim.
// `?key=` is an accepted auth carrier (Gemini-native clients), which put live
// API keys into `docker logs`, log shippers and support bundles. The fix is a
// custom format that logs only `$uri` (path, no query string) and applies it
// to the server.

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');

describe('nginx access log', () => {
  it('defines a log_format that never references the query-bearing request URI', () => {
    const match = conf.match(/log_format\s+(\w+)\s+([\s\S]*?);/);
    assert.ok(match, 'expected a log_format definition');
    const [, name, body] = match;
    assert.doesNotMatch(body, /\$request_uri\b/, 'logging $request_uri leaks ?key= into access logs');
    assert.doesNotMatch(body, /\$args\b/, 'logging $args leaks ?key= into access logs');
    assert.match(body, /\$uri\b/, 'the path-only variable must be logged instead');
    assert.equal(name, 'main_no_query');
  });

  it('never logs the Referer header, which is itself a URL that can carry ?key=', () => {
    const match = conf.match(/log_format\s+(\w+)\s+([\s\S]*?);/);
    assert.ok(match, 'expected a log_format definition');
    const [, , body] = match;
    assert.doesNotMatch(
      body,
      /\$http_referer\b/,
      'Referer is a URL: a link from a ?key= page copies the query into the access log'
    );
  });

  it('applies that format to the server instead of falling back to combined', () => {
    assert.match(conf, /access_log\s+\S+\s+main_no_query\s*;/);
    assert.doesNotMatch(conf, /access_log\s+[^;]*\bcombined\b/);
  });
});
