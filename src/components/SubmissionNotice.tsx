export function SubmissionNotice({
  words = [],
  uncertain = false,
}: {
  words?: string[];
  uncertain?: boolean;
}) {
  return (
    <div className="submission-notice">
      {words.length > 0 && (
        <div className="submission-notice-words" aria-label="Your move">
          {words.map((word, index) => (
            <span key={`${word}-${index}`}>{word}</span>
          ))}
        </div>
      )}
      <div className="submission-notice-status" role="status">
        <span className="submission-notice-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <p>
          {uncertain
            ? "We haven’t heard back from the game server yet. Your letters are safe here. Tap Check my move to find out whether it went through."
            : "We’re waiting for the game server to reply. Please wait a moment — play will continue once your move is confirmed."}
        </p>
      </div>
    </div>
  );
}
