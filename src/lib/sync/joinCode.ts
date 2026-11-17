export interface JoinInfo {
  url: string;
  key: string;
}

const PREFIX = 'tmb1.';
const BAD = "That join code isn't valid. Ask your admin to copy it again.";

const toB64Url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64Url(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b + '='.repeat((4 - (b.length % 4)) % 4));
}

function clean(info: JoinInfo): JoinInfo {
  return { url: info.url.trim().replace(/\/+$/, ''), key: info.key.trim() };
}

function valid(info: JoinInfo): boolean {
  return /^https:\/\/[^\s/]+$/.test(info.url) && info.key.length >= 20;
}

export function encodeJoinCode(info: JoinInfo): string {
  const c = clean(info);
  return PREFIX + toB64Url(JSON.stringify({ u: c.url, k: c.key }));
}

export function decodeJoinCode(code: string): JoinInfo {
  const s = code.trim();
  if (!s.startsWith(PREFIX)) throw new Error(BAD);
  let info: JoinInfo;
  try {
    const o = JSON.parse(fromB64Url(s.slice(PREFIX.length)));
    info = clean({ url: String(o.u ?? ''), key: String(o.k ?? '') });
  } catch {
    throw new Error(BAD);
  }
  if (!valid(info)) throw new Error(BAD);
  return info;
}
