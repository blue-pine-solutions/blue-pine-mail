import Link from "next/link";
import { ABOUT_PATH, DISTRIBUTION, SOURCE_PATH } from "@/lib/distribution/identity";

/**
 * The persistent AGPL source offer and attribution line. It always names the
 * distribution, even when an admin has rebranded the app.
 */
export function SourceNotice({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
	const links = (
		<>
			<a href={SOURCE_PATH} className="hover:underline" target="_blank" rel="noreferrer">Source</a>
			{" · "}
			<Link href={ABOUT_PATH} className="hover:underline">About</Link>
		</>
	);
	if (compact) return <p className={`text-[11px] text-neutral-400 ${className}`}>{links}</p>;
	return (
		<p className={`text-[11px] text-neutral-400 ${className}`}>
			{DISTRIBUTION.name} {DISTRIBUTION.version}, based on {DISTRIBUTION.upstream.name} · {links}
		</p>
	);
}
