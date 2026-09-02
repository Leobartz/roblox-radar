const COOKIE_NAME = "papanoobhy_radar_session";
const STATE_COOKIE = "papanoobhy_radar_oauth_state";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const RAW_BASE = "https://raw.githubusercontent.com/Leobartz/roblox-radar";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/login") return startLogin(url, env);
    if (url.pathname === "/auth/callback") return finishLogin(request, url, env);
    if (url.pathname === "/logout") return logout(url);

    const session = await readSession(request, env.SESSION_SECRET);
    if (!session) return loginPage(url, env);

    return serveRadar(request, url);
  },
};

function configured(env) {
  return Boolean(
    env.GITHUB_CLIENT_ID &&
      env.GITHUB_CLIENT_SECRET &&
      env.SESSION_SECRET &&
      env.ALLOWED_GITHUB_LOGIN,
  );
}

function startLogin(url, env) {
  if (!configured(env)) return loginPage(url, env, true);

  const state = crypto.randomUUID();
  const callback = `${url.origin}/auth/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "Cache-Control": "no-store",
    },
  });
}

async function finishLogin(request, url, env) {
  if (!configured(env)) return loginPage(url, env, true);

  const state = url.searchParams.get("state") || "";
  const expectedState = readCookie(request, STATE_COOKIE);
  const code = url.searchParams.get("code") || "";
  if (!state || !expectedState || state !== expectedState || !code) {
    return errorPage("Tentativa de login inválida ou expirada.", 400);
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Papanoobhy-Radar",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.access_token) {
    return errorPage("O GitHub não conseguiu concluir o login.", 502);
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "Papanoobhy-Radar",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const user = await userResponse.json();
  if (!userResponse.ok || !user.login) {
    return errorPage("Não foi possível validar a conta do GitHub.", 502);
  }

  if (user.login.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
    return errorPage("Esta conta do GitHub não tem acesso ao radar.", 403);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ login: user.login, exp: expiresAt })),
  );
  const signature = await sign(payload, env.SESSION_SECRET);

  const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
  );
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );

  return new Response(null, { status: 302, headers });
}

function logout(url) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.origin,
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      "Cache-Control": "no-store",
    },
  });
}

async function readSession(request, secret) {
  if (!secret) return null;
  const value = readCookie(request, COOKIE_NAME);
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;

  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = await sign(payload, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  try {
    const data = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload)),
    );
    if (!data.login || Number(data.exp) <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

async function serveRadar(request, url) {
  const target = sourceFor(url.pathname);
  if (!target) return errorPage("Arquivo não encontrado.", 404);

  const upstream = await fetch(target, {
    headers: { "User-Agent": "Papanoobhy-Radar" },
    cf: { cacheEverything: true, cacheTtl: 60 },
  });
  if (!upstream.ok) return errorPage("O radar está atualizando. Tente novamente em instantes.", 502);

  let body;
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await upstream.text();
    body = html.replace(
      "</body>",
      '<a href="/logout" style="position:fixed;right:14px;bottom:14px;z-index:20;padding:7px 11px;border-radius:8px;background:#242a38;color:#a0a8ba;border:1px solid #2a3040;font:12px system-ui;text-decoration:none">Sair</a></body>',
    );
  } else {
    body = upstream.body;
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType(url.pathname));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");

  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

function sourceFor(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return `${RAW_BASE}/main/site/index.html`;
  }
  if (pathname === "/chart.umd.js") {
    return `${RAW_BASE}/main/site/chart.umd.js`;
  }
  if (pathname.startsWith("/data/")) {
    const path = pathname.slice("/data/".length);
    if (!path || path.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(path)) return null;
    return `${RAW_BASE}/data/${path}`;
  }
  return null;
}

function contentType(pathname) {
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}

function loginPage(url, env, setup = false) {
  const ready = configured(env);
  const message = setup || !ready
    ? "A autenticação está sendo configurada. Tente novamente em alguns minutos."
    : "Entre com a conta GitHub autorizada para abrir o radar.";
  const action = ready
    ? '<a class="button" href="/login">Entrar com GitHub</a>'
    : '<span class="button disabled">Configuração em andamento</span>';

  return new Response(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Papanoobhy Radar — Login</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#e8ebf2;font:15px/1.5 system-ui}
.card{width:min(420px,calc(100% - 32px));box-sizing:border-box;background:#161a23;border:1px solid #2a3040;border-radius:16px;padding:30px;text-align:center;box-shadow:0 18px 60px #0008}
.frog{font-size:52px}.accent{color:#4fd1c5}p{color:#a0a8ba}.button{display:inline-block;margin-top:12px;padding:11px 18px;border-radius:10px;background:#4fd1c5;color:#06221f;font-weight:700;text-decoration:none}.disabled{background:#242a38;color:#6b7386}
</style></head><body><main class="card"><div class="frog">🐸</div><h1>Papanoobhy <span class="accent">Radar</span></h1><p>${message}</p>${action}</main></body></html>`, {
    status: ready ? 401 : 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function errorPage(message, status) {
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Papanoobhy Radar</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#e8ebf2;font:16px system-ui"><main style="text-align:center;padding:24px"><h1>🐸 Papanoobhy Radar</h1><p>${message}</p><p><a style="color:#4fd1c5" href="/">Voltar</a></p></main></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function readCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i += 1) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
