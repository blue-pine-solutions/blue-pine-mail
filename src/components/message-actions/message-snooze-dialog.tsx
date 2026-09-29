"use client";

import { useState } from "react";
import { getSnoozePresets, snoozeMessage } from "@/components/messages/message-list-row-actions-utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { MessageSnoozeDialogProps } from "./types";

export function MessageSnoozeDialog({ messageId, open, onOpenChange }: MessageSnoozeDialogProps) {
	const [snoozedUntil, setSnoozedUntil] = useState(() => getSnoozePresets()[0].value);
	const [snoozing, setSnoozing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const snoozePresets = getSnoozePresets();

	async function handleSnooze() {
		setSnoozing(true);
		setError(null);
		try {
			await snoozeMessage(messageId, snoozedUntil);
			onOpenChange(false);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Unable to snooze message");
		} finally {
			setSnoozing(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Snooze email</DialogTitle>
					<DialogDescription>Hide this email from the inbox until the time you choose.</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="grid gap-2 sm:grid-cols-3">
						{snoozePresets.map((preset) => (
							<Button key={preset.label} type="button" variant="outline" size="sm" onClick={() => setSnoozedUntil(preset.value)}>
								{preset.label}
							</Button>
						))}
					</div>
					<div className="space-y-2">
						<label htmlFor={`header-snooze-until-${messageId}`} className="text-sm font-medium text-neutral-700">Select date and time</label>
						<Input id={`header-snooze-until-${messageId}`} type="datetime-local" value={snoozedUntil} onChange={(event) => setSnoozedUntil(event.target.value)} />
					</div>
					{error && <p className="text-sm text-red-600">{error}</p>}
					<Button type="button" onClick={() => void handleSnooze()} disabled={snoozing}>
						{snoozing ? "Snoozing..." : "Snooze"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
