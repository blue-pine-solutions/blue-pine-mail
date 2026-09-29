import type { Metadata } from "next";
import Link from "next/link";
import { DISTRIBUTION, getBuildCommit, getSourceUrl } from "@/lib/distribution/identity";

// Build details come from the runtime environment, so render on each request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: `About ${DISTRIBUTION.name}` };

export default function AboutPage() {
	const commit = getBuildCommit();
	const sourceUrl = getSourceUrl(commit);
	const rows: { label: string; value: React.ReactNode }[] = [
		{ label: "Product", value: DISTRIBUTION.name },
		{ label: "Distributed by", value: DISTRIBUTION.vendor },
		{ label: "Version", value: DISTRIBUTION.version },
		{ label: "Based on", value: <><a href={DISTRIBUTION.upstream.repository} className="text-blue-700 hover:underline">{DISTRIBUTION.upstream.name}</a> {DISTRIBUTION.upstream.version} by {DISTRIBUTION.upstream.author}</> },
		{ label: "Build", value: commit ? <code className="text-xs">{commit}</code> : "Not recorded for this build" },
		{ label: "Source code", value: <a href={sourceUrl} className="break-all text-blue-700 hover:underline">{sourceUrl}</a> },
		{ label: "License", value: <a href={DISTRIBUTION.licenseUrl} className="text-blue-700 hover:underline">{DISTRIBUTION.licenseName} ({DISTRIBUTION.license})</a> },
	];

	return (
		<div className="min-h-dvh bg-[#f1f4fa] px-4 py-10 text-neutral-900">
			<main className="mx-auto max-w-2xl space-y-6 rounded-3xl bg-white p-8">
				<h1 className="text-2xl font-semibold">About {DISTRIBUTION.name}</h1>
				<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
					{rows.map(({ label, value }) => (
						<div key={label} className="contents">
							<dt className="text-neutral-500">{label}</dt>
							<dd>{value}</dd>
						</div>
					))}
				</dl>
				<div className="space-y-3 text-sm leading-6 text-neutral-600">
					<p>
						{DISTRIBUTION.name} is an independent downstream distribution of {DISTRIBUTION.upstream.name}, modified and distributed by {DISTRIBUTION.vendor}.
						It is not affiliated with or endorsed by the {DISTRIBUTION.upstream.name} project or its author. {DISTRIBUTION.upstream.name} is copyright {DISTRIBUTION.upstream.author} and its contributors.
					</p>
					<p>
						This program is free software, licensed under the {DISTRIBUTION.licenseName}. It is provided without any warranty.
						The complete Corresponding Source for the version you are using is available at the source code link above.
					</p>
				</div>
				<p className="text-sm"><Link href="/" className="text-blue-700 hover:underline">Back to {DISTRIBUTION.name}</Link></p>
			</main>
		</div>
	);
}
