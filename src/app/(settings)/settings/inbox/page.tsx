import { InboxThreadingSettings } from "@/components/settings/inbox-threading-settings";
import { InboxReadingLayoutSettings } from "@/components/settings/inbox-reading-layout-settings";
import { InboxShortcutsSettings } from "@/components/settings/inbox-shortcuts-settings";
import { MailboxAutoReplyForm } from "@/components/settings/mailbox-auto-reply-form";
import { SpamFilterSettings } from "@/components/settings/spam-filter-settings";
import { BrowserNotificationSettings } from "@/components/settings/browser-notification-settings";

export default function SettingsInboxPage() {
	return (
		<div className="space-y-8 py-4">
			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">Inbox experience</h2>
					<p className="mt-1 text-sm text-neutral-500">Choose how you read and interact with email.</p>
				</div>
				<div className="divide-y divide-neutral-100 rounded-3xl bg-white p-6">
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">Reading layout</h3>
							<p className="mt-1 text-sm text-neutral-500">Choose how open emails appear.</p>
						</div>
						<InboxReadingLayoutSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">Threading</h3>
							<p className="mt-1 text-sm text-neutral-500">Choose how emails are organized in your inbox.</p>
						</div>
						<InboxThreadingSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">Shortcuts</h3>
							<p className="mt-1 text-sm text-neutral-500">Choose whether keyboard shortcuts are active.</p>
						</div>
						<InboxShortcutsSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">Notifications</h3>
							<p className="mt-1 text-sm text-neutral-500">Choose how you hear about new email.</p>
						</div>
						<BrowserNotificationSettings />
					</div>
				</div>
			</section>
			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">Message handling</h2>
					<p className="mt-1 text-sm text-neutral-500">Manage spam protection and automatic replies.</p>
				</div>
				<div className="divide-y divide-neutral-100 rounded-3xl bg-white p-6">
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">Spam protection</h3>
							<p className="mt-1 text-sm text-neutral-500">Control local spam analysis for incoming messages.</p>
						</div>
						<SpamFilterSettings />
					</div>
					<div className="py-6 first:pt-0 last:pb-0">
						<div className="mb-4">
							<h3 className="text-base font-semibold text-neutral-900">Automatic response</h3>
							<p className="mt-1 text-sm text-neutral-500">
								Configure the subject and message for the inbox currently selected above.
							</p>
						</div>
						<MailboxAutoReplyForm />
					</div>
				</div>
			</section>
		</div>
	);
}
