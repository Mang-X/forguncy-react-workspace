import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoApiUrl } from './api-url.mjs';
const base = 'https://api.github.com/repos/Mang-X/forguncy-react-workspace/';
const idBase = 'https://api.github.com/repositories/1372808235/';
test('named repository pagination preserves query and canonical address', () => {
  const url = base + 'issues?state=all&per_page=100&page=2';
  assert.equal(normalizeRepoApiUrl(url), url);
});
test('GitHub numeric repository Link uses the same canonical request key', () => {
  assert.equal(normalizeRepoApiUrl(idBase+'issues?page=2'), base+'issues?page=2');
  assert.equal(normalizeRepoApiUrl(idBase+'pulls?page=2'), base+'pulls?page=2');
});
test('native dependency pagination accepts only the same immutable repository id', () => {
  assert.equal(normalizeRepoApiUrl(idBase+'issues/83/dependencies/blocked_by?page=2'), base+'issues/83/dependencies/blocked_by?page=2');
  assert.throws(() => normalizeRepoApiUrl('https://api.github.com/repositories/999/issues?page=2'));
});
test('repository owner and name casing canonicalize consistently', () => {
  assert.equal(normalizeRepoApiUrl(base.toLowerCase()+'issues?page=2'), base+'issues?page=2');
});
test('cross-repository and lookalike repository paths are refused', () => {
  for (const url of [base.replace('Mang-X','Other')+'issues',base.replace('workspace/','workspace-evil/')+'issues','https://api.github.com/repos/Mang-X/forguncy-react-workspace/../other/issues']) assert.throws(() => normalizeRepoApiUrl(url));
});
test('untrusted origins, credentials, nonstandard ports and fragments are refused', () => {
  for (const url of [base.replace('https:', 'http:'),base.replace('api.github.com','api.github.com.evil.test'),base.replace('api.github.com','user:password@api.github.com'),base.replace('api.github.com','api.github.com:8443'),base+'issues#fragment']) assert.throws(() => normalizeRepoApiUrl(url));
});
test('only read endpoints used by this board are accepted', () => {
  for (const suffix of ['actions/secrets','issues/83/comments','issues/83','pulls/108','issues/%31/dependencies/blocked_by']) assert.throws(() => normalizeRepoApiUrl(base+suffix));
});
