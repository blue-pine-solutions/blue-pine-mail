import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-brand-bundle-"));
await build({
	stdin: {
		contents: `
			export { DISTRIBUTION } from "./src/lib/distribution/identity.ts";
			export { DEFAULT_APP_NAME, isDefaultBranding } from "./src/lib/branding/utils.ts";
			export { DEFAULT_ICON_URL, DEFAULT_LOGO } from "./src/components/branding-provider-utils.ts";
			export { BrandingContext } from "./src/components/branding-provider.tsx";
			export { AuthShell } from "./src/components/auth/auth-shell.tsx";
			export { default as AboutPage } from "./src/app/about/page.tsx";
			export { createElement } from "react";
			export { renderToStaticMarkup } from "react-dom/server";
		`,
		resolveDir: root,
		sourcefile: "brand-test-entry.tsx",
		loader: "tsx",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	jsx: "automatic",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"next/link": "next/link.js",
		"next/navigation": "next/navigation.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const NAME = "Blue Pine Solutions Mail";

function pngSize(path) {
	const bytes = readFileSync(join(root, path));
	assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path} is a PNG`);
	assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

test("the canonical product name is Blue Pine Solutions Mail; version and upstream identity are unchanged", () => {
	assert.equal(app.DISTRIBUTION.name, NAME);
	assert.equal(app.DEFAULT_APP_NAME, NAME);
	assert.equal(app.DISTRIBUTION.vendor, "Blue Pine Solutions");
	assert.equal(app.DISTRIBUTION.version, "0.1.2");
	assert.equal(app.DISTRIBUTION.upstream.name, "Mailflare");
	assert.equal(app.DISTRIBUTION.sourceRepository, "https://github.com/blue-pine-solutions/blue-pine-mail");
});

test("the approved masters and their runtime copies are present, with the expected sizes and transparency", () => {
	for (const master of ["brand/blue-pine-mail-logo-master.png", "brand/blue-pine-mail-mark-master.png"]) {
		assert.deepEqual(pngSize(master), { width: 500, height: 500, colorType: 6 }, `${master} is the 500x500 RGBA master`);
	}
	assert.deepEqual(pngSize("public/brand/blue-pine-mail-logo.png"), { width: 500, height: 500, colorType: 6 });
	const webp = readFileSync(join(root, "public/brand/blue-pine-mail-logo.webp"));
	assert.equal(webp.subarray(0, 4).toString("ascii"), "RIFF");
	assert.equal(webp.subarray(8, 12).toString("ascii"), "WEBP");
	assert.deepEqual(pngSize("public/icon-192.png"), { width: 192, height: 192, colorType: 6 });
	assert.deepEqual(pngSize("public/icon-96.png"), { width: 96, height: 96, colorType: 6 });
	assert.deepEqual(app.DEFAULT_LOGO, { webp: "/brand/blue-pine-mail-logo.webp", png: "/brand/blue-pine-mail-logo.png", width: 500, height: 500 });
	assert.equal(app.DEFAULT_ICON_URL, "/icon-192.png");
});

test("favicon.ico carries 16x16 and 32x32 frames", () => {
	const ico = readFileSync(join(root, "public/favicon.ico"));
	assert.equal(ico.readUInt16LE(2), 1, "icon resource");
	const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16] || 256).sort((a, b) => a - b);
	assert.deepEqual(sizes, [16, 32]);
});

test("the inherited upstream icon-48 is gone and the default-icon contract still uses /icon-96.png", () => {
	assert.ok(!existsSync(join(root, "public/icon-48.png")));
	assert.doesNotMatch(read("src/app/layout.tsx") + read("src/app/page.tsx") + read("src/components/branding-provider.tsx"), /icon-48/);
	assert.match(read("src/app/api/branding/icon/route.ts"), /env\.ASSETS\.fetch\("https:\/\/mailflare\.local\/icon-96\.png"\)/, "the branding icon route still falls back to /icon-96.png");
	assert.match(read("src/app/layout.tsx"), /icons: \{ icon: "\/api\/branding\/icon" \}/, "the favicon still comes from the branding icon route");
	assert.match(read("src/components/auth/auth-shell.tsx"), /setIconUrl\("\/icon-96\.png"\)/, "AuthShell keeps its /icon-96.png fallback");
});

const renderShell = (branding) => app.renderToStaticMarkup(
	app.createElement(app.BrandingContext.Provider, { value: { iconUrl: "/icon-192.png", refreshBranding: async () => undefined, canCustomizeBranding: true, ...branding } },
		app.createElement(app.AuthShell, { icon: () => null, title: "Sign in" }, "form")),
);

test("with default branding, AuthShell shows the full Blue Pine Solutions Mail logo", () => {
	const html = renderShell({ appName: NAME, hasCustomIcon: false, loaded: true });
	assert.ok(html.includes('srcSet="/brand/blue-pine-mail-logo.webp"'));
	assert.ok(html.includes('src="/brand/blue-pine-mail-logo.png"'));
	assert.ok(html.includes(`alt="${NAME}"`));
	assert.ok(!html.includes('src="/icon-192.png"'), "the full logo replaces the small icon");
	assert.ok(html.includes('href="/source"') && html.includes('href="/about"'), "the source notice stays");
});

test("with custom branding, AuthShell keeps the administrator's icon and name and never shows the Blue Pine logo", () => {
	for (const branding of [
		{ appName: "Acme Mail", hasCustomIcon: true, iconUrl: "/api/branding/icon?v=1" },
		{ appName: "Acme Mail", hasCustomIcon: false },
		{ appName: NAME, hasCustomIcon: true, iconUrl: "/api/branding/icon?v=1" },
	]) {
		const html = renderShell({ ...branding, loaded: true });
		assert.ok(!html.includes("blue-pine-mail-logo"), JSON.stringify(branding));
		assert.ok(html.includes(`>${branding.appName}<`), "the configured name is shown");
		assert.ok(html.includes(`src="${branding.iconUrl ?? "/icon-192.png"}"`), "the configured or default icon is shown");
	}
	const pending = renderShell({ appName: NAME, hasCustomIcon: false, loaded: false });
	assert.ok(!pending.includes("blue-pine-mail-logo") && !pending.includes("<img"), "nothing brand-specific is shown before branding has loaded");
	assert.equal(app.isDefaultBranding({ appName: NAME, hasCustomIcon: false }), true);
	assert.equal(app.isDefaultBranding({ appName: "Acme Mail", hasCustomIcon: false }), false);
	assert.equal(app.isDefaultBranding({ appName: NAME, hasCustomIcon: true }), false);
});

test("/about shows the full logo and the Blue Pine Solutions Mail identity with textual upstream attribution", () => {
	const html = app.renderToStaticMarkup(app.createElement(app.AboutPage));
	const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
	assert.ok(html.includes('src="/brand/blue-pine-mail-logo.png"') && html.includes('srcSet="/brand/blue-pine-mail-logo.webp"'));
	assert.ok(html.includes(`alt="${NAME} logo"`));
	for (const phrase of [`About ${NAME}`, "Distributed by Blue Pine Solutions", "Mailflare 0.4.0 by Hieu Nguyen", "not affiliated with or endorsed by the Mailflare project"]) {
		assert.ok(visible.includes(phrase), phrase);
	}
});

// "Blue Pine Mail" is the product's earlier name. It may remain only where it is historical or technical.
const ALLOWED_OLD_NAME = {
	"src/lib/branding/utils.ts": [/Blue Pine Mail 0\.1\.0 and 0\.1\.1 shipped with this/, /\[UPSTREAM_DEFAULT_APP_NAME, "Blue Pine Mail"\]/],
	"UPSTREAM.md": [/published under the earlier product name "Blue Pine Mail"/, /A stored app name of "Blue Pine Mail" counts as never customized/],
	NOTICE: [/published under the earlier name Blue Pine Mail/],
};
const AUDITED_ROOTS = ["src", "server", "scripts", "docs", "deploy", "public", "brand", "worker.ts", "README.md", "NOTICE", "UPSTREAM.md", "CLAUDE.md", "package.json", "Dockerfile", ".env.docker.example", ".dev.vars.example", "wrangler.jsonc.example"];

test("the earlier name Blue Pine Mail remains only in documented historical or technical places", () => {
	const files = [];
	const visit = (path) => {
		const full = join(root, path);
		if (!existsSync(full)) return;
		if (statSync(full).isDirectory()) for (const name of readdirSync(full)) visit(`${path}/${name}`);
		else if (!/\.(png|jpe?g|gif|ico|webp|woff2?)$/i.test(path)) files.push(path);
	};
	for (const path of AUDITED_ROOTS) visit(path);
	for (const path of files) {
		let text = read(path).replace(/\s+/g, " ");
		for (const allowed of ALLOWED_OLD_NAME[path] ?? []) {
			assert.match(text, allowed, `${path} should still contain its documented occurrence`);
			text = text.replace(allowed, "");
		}
		assert.doesNotMatch(text, /Blue Pine Mail/i, `${path} uses the earlier product name`);
	}
});
