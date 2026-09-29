"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Columns2 } from "lucide-react";
import clsx from "clsx";
import { Tooltip } from "@/components/ui/tooltip";
import { useMessageListVisibility } from "./message-list-visibility";
import type { MessageReadingHeaderButtonProps } from "./message-reading-header-button-types";

export function MessageReadingHeaderButton({ assistantVisible }: MessageReadingHeaderButtonProps) {
	const router = useRouter();
	const { visible, toggle, singleColumn, backHref, backLabel } = useMessageListVisibility();
	const label = singleColumn
		? `Back to ${backLabel}`
		: assistantVisible ? null : visible ? "Hide email list" : "Show email list";

	function handleClick() {
		if (singleColumn) router.push(backHref);
		else toggle();
	}

	return (
		<Tooltip label={label} className={singleColumn ? "inline-flex" : "hidden lg:inline-flex"}>
			<button
				type="button"
				className={clsx(!singleColumn && assistantVisible ? "opacity-40" : !singleColumn && !visible ? "opacity-60 hover:opacity-100" : "", (singleColumn || !assistantVisible) && "hover:bg-neutral-100 hover:text-neutral-900", "relative z-10 shrink-0 rounded-full p-2 text-neutral-600 duration-200")}
				onClick={handleClick}
				disabled={!singleColumn && assistantVisible}
				aria-label={label ?? "Email list unavailable"}
				aria-pressed={singleColumn ? undefined : visible}
			>
				{singleColumn ? <ArrowLeft size={18} /> : <Columns2 size={18} />}
			</button>
		</Tooltip>
	);
}
