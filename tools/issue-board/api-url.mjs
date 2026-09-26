// GitHub Link headers may use the immutable repository-id URL instead of /repos/.
// Both are the same repository; do not widen the allowlist to arbitrary API URLs.
export function normalizeRepoApiUrl(value) {
  const url = new URL(value);
  const named = '/repos/Mang-X/forguncy-react-workspace/';
  const numeric = '/repositories/1372808235/';
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) {
    throw new Error('拒绝非 GitHub 仓库 API 地址');
  }
  let suffix;
  if (url.pathname.toLowerCase().startsWith(named.toLowerCase())) suffix = url.pathname.slice(named.length);
  else if (url.pathname.startsWith(numeric)) suffix = url.pathname.slice(numeric.length);
  else throw new Error('分页指向其他仓库，保留上次快照');
  if (!/^(?:issues|pulls|issues\/\d+\/dependencies\/blocked_by)$/.test(suffix)) {
    throw new Error('拒绝不属于 Issue 看板的 API 路径');
  }
  url.pathname = named + suffix;
  return url.href;
}
