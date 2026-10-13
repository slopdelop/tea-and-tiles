const releases = [
  {
    version: "1.5.1",
    items: [
      "Drag onto another unplayed tile to replace it and return that tile to your hand.",
    ],
  },
  {
    version: "1.5.0",
    items: [
      "Smoother tile interaction with less repeated board rendering.",
      "Reduced unnecessary database writes, historical request reads and duplicate checks.",
      "A smaller wooden-rack texture keeps the subtle grain with less to download.",
    ],
  },
  {
    version: "1.4.1",
    items: [
      "Changed how iPad and Safari receive game updates to address occasional delayed turns.",
    ],
  },
  {
    version: "1.4.0",
    items: [
      "Each new game randomly chooses who starts.",
      "A brief notice shows how many tiles your partner exchanged, followed by the next turn.",
      "Long words fit on one scoring row, and scoring has fewer buttons.",
      "New game glows after you close the results; tablet glow and touch-button styling are improved.",
      "Updates can install automatically at the start of a new game, before you begin placing tiles.",
    ],
  },
  {
    version: "1.3.0",
    items: [
      "New tiles appear on the board before their points are counted.",
      "Clearer messages and safe retry controls for moves taking longer to confirm.",
      "Smoother scoring, clearer final tallies, gold winner fireworks and shimmering highlights.",
    ],
  },
  {
    version: "1.2.2",
    items: ["Improved scoring-card width and space around animated letters."],
  },
  { version: "1.2.1", items: ["More natural wording in local test scenes."] },
  {
    version: "1.2.0",
    items: [
      "Game endings explain the reason, count final scores and celebrate the winner.",
      "Added local preview tools for testing game events.",
    ],
  },
  {
    version: "1.1.5",
    items: ["New game received a glowing cue after a game ends."],
  },
  {
    version: "1.1.4",
    items: [
      "Tap a placed tile, then the wooden holder, to return it to your hand.",
    ],
  },
  {
    version: "1.1.3",
    items: [
      "Improved tablet scrolling and prevented accidental text selection.",
    ],
  },
  { version: "1.1.2", items: ["Kept New game visible after the game ends."] },
  {
    version: "1.1.1",
    items: [
      "Added recovery for unwanted zoom when an installed iPad app resumes.",
    ],
  },
  {
    version: "1.1.0",
    items: [
      "Improved tablet fit, word-check colors, agreed endings and best-word summaries.",
      "Added version and build date/time.",
    ],
  },
  {
    version: "1.0.0",
    items: [
      "First complete family game: shared play, tile arranging, themes, word approval, game modes and animated scoring.",
    ],
  },
];

export default function Changelog() {
  return (
    <section className="help-changelog" data-testid="release-changelog">
      <h3 className="help-section-title">What’s new</h3>
      {releases.map((release, index) => (
        <details key={release.version} open={index === 0}>
          <summary>Version {release.version}</summary>
          <ul>
            {release.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
