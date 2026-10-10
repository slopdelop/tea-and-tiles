export default function AppVersion() {
  return (
    <p className="setup-note" data-testid="app-version">
      Version {import.meta.env.VITE_APP_VERSION}
    </p>
  );
}
