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
            ? "Your letters are still here. Tap Try again to send your move again."
            : "We’re waiting to hear from the game. Please wait a moment."}
        </p>
      </div>
    </div>
  );
}
