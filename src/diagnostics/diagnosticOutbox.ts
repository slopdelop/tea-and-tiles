import {
  MOVE_DIAGNOSTICS,
  type DiagnosticReply,
  type MoveDiagnosticReport,
} from "../../shared/move-diagnostics";

/** Rare incident reports survive a failed connection/reload, with the same ID. */
export function createDiagnosticOutbox(options: {
  load: () => MoveDiagnosticReport[];
  save: (reports: MoveDiagnosticReport[]) => void;
  send: (report: MoveDiagnosticReport) => Promise<DiagnosticReply>;
  online: () => boolean;
  now: () => number;
}) {
  let queue = options.load().slice(-MOVE_DIAGNOSTICS.dailyReports);
  const active = new Map<string, Promise<DiagnosticReply>>();
  const attempted = new Map<string, number>();
  function attempt(report: MoveDiagnosticReport) {
    const pending = active.get(report.id);
    if (pending) return pending;
    if (!options.online())
      return Promise.reject(new Error("Diagnostic upload offline"));
    attempted.set(report.id, options.now());
    const operation = Promise.resolve()
      .then(() => options.send(report))
      .then((reply) => {
        queue = reply.enabled
          ? queue.filter((item) => item.id !== report.id)
          : [];
        options.save(queue);
        return reply;
      })
      .finally(() => active.delete(report.id));
    active.set(report.id, operation);
    return operation;
  }
  return {
    submit(report: MoveDiagnosticReport) {
      queue = [...queue.filter((item) => item.id !== report.id), report].slice(
        -MOVE_DIAGNOSTICS.dailyReports,
      );
      options.save(queue);
      return attempt(report);
    },
    async flush() {
      for (const report of [...queue]) {
        if (options.now() - (attempted.get(report.id) ?? -Infinity) < 60_000)
          continue;
        try {
          const reply = await attempt(report);
          if (!reply.enabled) break;
        } catch {
          break;
        } // No retry loop; try again only on start/resume/reconnection.
      }
    },
  };
}
