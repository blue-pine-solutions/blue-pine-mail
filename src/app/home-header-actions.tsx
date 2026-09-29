"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getHomeActions } from "./utils";
import { HomeAccountMenu } from "./home-account-menu";
import { useHomeAuth } from "./home-auth";

export function HomeHeaderActions() {
	const user = useHomeAuth();
	if (user) return <HomeAccountMenu user={user} />;

	return (
		<>
			{getHomeActions(false).map((action) => (
				<Button key={action.href} variant={action.variant} asChild>
					<Link href={action.href}>{action.label}</Link>
				</Button>
			))}
		</>
	);
}
