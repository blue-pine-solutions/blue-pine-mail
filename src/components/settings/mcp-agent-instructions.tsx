"use client";

import { useEffect, useState } from "react";
import { useBranding } from "@/components/branding-provider";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildMcpAgentPrompt } from "./mcp-agent-instructions-utils";
import type { McpAgentInstructionsProps } from "./mcp-agent-instructions-types";

export function McpAgentInstructions(props: McpAgentInstructionsProps) {
	const { appName } = useBranding();
	const [origin, setOrigin] = useState("");
	const [copied, setCopied] = useState(false);
	useEffect(() => setOrigin(window.location.origin), []);
	const prompt = buildMcpAgentPrompt(origin, props, appName);

	return <div className="space-y-2 rounded-lg border border-neutral-200 p-3">
		<div className="flex items-center justify-between gap-3">
			<strong className="text-sm">Instructions for your AI agent</strong>
			<Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(prompt).then(() => setCopied(true))}><Copy className="h-4 w-4" />{copied ? "Copied" : "Copy prompt"}</Button>
		</div>
		<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-3 text-xs text-neutral-700">{prompt}</pre>
	</div>;
}
