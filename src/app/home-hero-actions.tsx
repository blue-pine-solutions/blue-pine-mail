"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHomeAuth } from "./home-auth";

export function HomeHeroActions() {
	const hasUser = !!useHomeAuth();

	return (
		<div className="mt-8 flex flex-col gap-3 sm:flex-row">
			<Button size="lg" asChild className="rounded-full px-6">
				<Link href={hasUser ? "/inbox" : "/setup"}>
					{hasUser ? "Open dashboard" : "Create account"}
					<ArrowRight className="h-4 w-4" />
				</Link>
			</Button>
			<Button size="lg" variant="outline" asChild className="rounded-full border-neutral-200 bg-white px-6">
				<Link href={hasUser ? "/inbox" : "/login"}>
					{hasUser ? "View inbox" : "Log in"}
				</Link>
			</Button>
		</div>
	);
}
