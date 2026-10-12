import { useSyncExternalStore } from "react";
import { getBuildTime, subscribeBuildTime } from "../buildTime";

export default function AppVersion() {
  const builtAt = useSyncExternalStore(subscribeBuildTime, getBuildTime);
  const buildLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(builtAt));
  return (
    <p className="setup-note" data-testid="app-version">
      Version {import.meta.env.VITE_APP_VERSION}
      <br />
      Built{" "}
      <time dateTime={builtAt} data-testid="build-time">
        {buildLabel}
      </time>
    </p>
  );
}
