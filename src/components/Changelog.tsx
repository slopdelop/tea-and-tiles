const releases = [
  {
    version: "1.7.1",
    items: [
      "Games and New game stay side by side, with Help in the bottom-right corner.",
      "Smaller iPad Recall and Shuffle controls fit beside the centered tile rack, including shorter Safari views.",
      "Audio is disabled and the sound toggle has been removed.",
    ],
  },
  {
    version: "1.7.0",
    items: [
      "Play private games with more family members, with a Games menu and sign out.",
      "Games badges and gentle notices show activity and requests at other tables.",
      "Clearer word review, larger controls and text, and simpler Help navigation.",
      "A family dictionary everyone can contribute to, and game duration based on online play time.",
      "Refined scoring, results and tablet layouts, with more local preview tools.",
    ],
  },
  {
    version: "1.6.1",
    items: [
      "Less repeated screen rendering while dragging tiles, with more direct touch tracking.",
      "Refined drag cancellation while preserving tile placement and rack rearrangement.",
      "Adjusted the iPad and Safari receiving connection to help investigate occasional delayed turns.",
    ],
  },
  {
    version: "1.6.0",
    items: [
      "More reliable automatic updates between games, while keeping unfinished moves safe.",
      "Friendlier messages when sending a move takes longer, with fewer unnecessary popups.",
      "Game length is included in the final report, with minutes, hours and days as needed.",
      "Arranging a tile dismisses the turn announcement without replaying it.",
      "Temporary, limited diagnostics help investigate occasional delayed updates between devices.",
    ],
  },
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
