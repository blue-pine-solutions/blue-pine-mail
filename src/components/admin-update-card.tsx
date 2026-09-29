"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleX, Database, PackageCheck, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DISTRIBUTION } from "@/lib/distribution/identity";
import { applyDatabaseMigrations, describeRelease, getMigrationStatus, getVersionStatus } from "./admin-update-card-utils";
import type { MigrationStatusResponse, VersionStatusResponse } from "./admin-update-card-types";

export function AdminUpdateCard() {
	const [status, setStatus] = useState<VersionStatusResponse>();
	const [error, setError] = useState("");
	const [migrationError, setMigrationError] = useState("");
	const [migrationStatus, setMigrationStatus] = useState<MigrationStatusResponse>();
	const [isChecking, setIsChecking] = useState(true);
	const [isCheckingMigrations, setIsCheckingMigrations] = useState(true);
	const [isMigrating, setIsMigrating] = useState(false);

	useEffect(() => {
		let isActive = true;

		getVersionStatus()
			.then((versionStatus) => {
				if (isActive) setStatus(versionStatus);
			})
			.catch((statusError) => {
				if (isActive) setError(statusError instanceof Error ? statusError.message : "Could not check the installed version");
			})
			.finally(() => {
				if (isActive) setIsChecking(false);
			});

		getMigrationStatus()
			.then((databaseStatus) => {
				if (isActive) setMigrationStatus(databaseStatus);
			})
			.catch((statusError) => {
				if (isActive) {
					setMigrationError(statusError instanceof Error ? statusError.message : "Could not check database migrations");
				}
			})
			.finally(() => {
				if (isActive) setIsCheckingMigrations(false);
			});

		return () => {
			isActive = false;
		};
	}, []);

	async function handleMigrate() {
		setMigrationError("");
		setIsMigrating(true);
		try {
			setMigrationStatus(await applyDatabaseMigrations());
		} catch (migrationFailure) {
			setMigrationError(
				migrationFailure instanceof Error ? migrationFailure.message : "Could not apply database migrations",
			);
		} finally {
			setIsMigrating(false);
		}
	}

	const installed = status?.installed;
	const release = status?.release;

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
					<RefreshCw className="h-5 w-5" />
				</div>
				<div>
					<CardTitle className="text-base">Version and updates</CardTitle>
					<p className="mt-1 text-sm text-neutral-500">
						The installed version, approved releases and database migrations. Releases are installed by deploying them, not from this page.
					</p>
				</div>
			</CardHeader>
			<CardContent className="space-y-5 pt-5">
				{isChecking && <Skeleton className="h-20 w-full rounded-2xl" />}

				{!isChecking && installed && release && (
					<div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-100">
						<div className="flex items-start gap-3 px-4 py-4">
							<PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
							<div className="min-w-0 text-sm text-neutral-700">
								<p>{installed.name} {installed.version}</p>
								<p className="text-xs text-neutral-500">
									Build {installed.buildCommit ? <code>{installed.buildCommit.slice(0, 12)}</code> : "not recorded"} · based on {installed.upstream.name} {installed.upstream.version}
								</p>
							</div>
						</div>
						<div className="flex items-start gap-3 px-4 py-4">
							{release.state === "update-available" ? (
								<RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
							) : release.state === "unavailable" ? (
								<CircleX className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
							) : (
								<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
							)}
							<p className="min-w-0 text-sm text-neutral-700">{describeRelease(release, installed.name)}</p>
							{(release.state === "update-available" || release.state === "up-to-date") && (
								<a className="ml-auto shrink-0 text-sm font-medium text-blue-700 hover:underline" href={release.releaseUrl} target="_blank" rel="noreferrer">
									Release notes
								</a>
							)}
						</div>
					</div>
				)}

				<div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-100">
					{isCheckingMigrations && (
						<div className="flex items-center gap-3 px-4 py-4">
							<Skeleton className="h-4 w-4 rounded-full" />
							<Skeleton className="h-4 w-44" />
						</div>
					)}

					{!isCheckingMigrations && migrationStatus?.ready && (
						<div className="flex items-center gap-3 px-4 py-4">
							<Database className="h-4 w-4 shrink-0 text-green-600" />
							<p className="text-sm text-neutral-700">The database is up to date for this build.</p>
						</div>
					)}

					{!isCheckingMigrations && !!migrationStatus?.pending.length && !migrationStatus.unknown.length && (
						<div className="flex items-center gap-3 px-4 py-4">
							<Database className={`h-4 w-4 shrink-0 text-amber-600 ${isMigrating ? "animate-pulse" : ""}`} />
							<p className="text-sm text-neutral-700">
								{migrationStatus.pending.length} database {migrationStatus.pending.length === 1 ? "migration is" : "migrations are"} pending.
							</p>
							<button
								type="button"
								onClick={handleMigrate}
								disabled={isMigrating}
								className="ml-auto shrink-0 text-sm font-medium text-blue-700 hover:underline disabled:pointer-events-none disabled:opacity-50"
							>
								{isMigrating ? "Updating database..." : "Update database"}
							</button>
						</div>
					)}

					{!isCheckingMigrations && !!migrationStatus?.unknown.length && (
						<div className="flex items-center gap-3 px-4 py-4 text-sm text-red-600">
							<CircleX className="h-4 w-4 shrink-0" />
							This database has migrations this build does not include. Deploy the matching {installed?.name ?? DISTRIBUTION.name} release before changing it.
						</div>
					)}
				</div>

				{error && <p className="text-sm text-red-600">{error}</p>}
				{migrationError && <p className="text-sm text-red-600">{migrationError}</p>}
			</CardContent>
		</Card>
	);
}
