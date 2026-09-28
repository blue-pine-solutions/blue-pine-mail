import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { sidebarBootstrapScript } from "@/components/sidebar-state-utils";
import { DEFAULT_APP_NAME } from "@/lib/branding/utils";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: DEFAULT_APP_NAME,
	description: "Multi-tenant email on Cloudflare",
	icons: { icon: "/api/branding/icon" },
	robots: {
		index: false,
		follow: false,
		noarchive: true,
		nosnippet: true,
		noimageindex: true,
		googleBot: {
			index: false,
			follow: false,
			noarchive: true,
			nosnippet: true,
			noimageindex: true,
		},
	},
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<head>
				<script dangerouslySetInnerHTML={{ __html: sidebarBootstrapScript }} />
				<link rel="icon" href="/api/branding/icon"></link>
			</head>
			<body className={`${geistSans.variable} ${geistMono.variable} antialiased light`}>
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
