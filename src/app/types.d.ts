import type { LucideIcon } from "lucide-react";
import type { ButtonProps } from "@/components/ui/button";
import type { MailboxSelectorUser } from "@/components/mailbox-selector-types";
import type { ReactNode } from "react";

export type HomeAuthProviderProps = {
	children: ReactNode;
};

export type HomeAuthResponse = {
	user?: MailboxSelectorUser;
};

export type HomeAccountMenuProps = {
	user: MailboxSelectorUser;
};

export type HomeAction = {
	href: string;
	label: string;
	variant: ButtonProps["variant"];
};

export type LandingNavItem = {
	href: string;
	label: string;
};

export type SidebarItem = {
	label: string;
	icon: LucideIcon;
	active?: boolean;
	count?: string;
};

export type MailPreview = {
	icon: LucideIcon;
	sender: string;
	subject: string;
	preview: string;
	badge: string;
};

export type LandingStat = {
	value: string;
	label: string;
};
