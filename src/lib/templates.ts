// Preset challenges from docs/design/challenge-templates.md. Picking one
// fills in the title and the rule; the creator can still change anything.

export type Template = {
  name: string;
  goal: string;
  recommendation: string;
  /** What counts as a check-in; becomes the challenge rule. */
  rule: string;
};

export const templates: Template[] = [
  {
    name: 'Read a Book',
    goal: 'Build a consistent reading habit and improve focus by spending dedicated time each day reading a book.',
    recommendation: 'Choose a book you enjoy and aim to read in a distraction-free environment.',
    rule: 'A photo of the open book you are currently reading, every day.',
  },
  {
    name: 'Workout',
    goal: 'Stay active daily.',
    recommendation:
      'Alternate between lifting, HIIT, cardio, stretching and recovery to avoid fatigue and injury.',
    rule: 'A photo taken in a gym or any workout environment, every day.',
  },
  {
    name: 'Sunshine',
    goal: 'Spend time outdoors daily to support mental well-being, energy levels and routine.',
    recommendation: 'Getting sunlight first thing in the morning is ideal.',
    rule: 'A photo taken outdoors during daytime, every day.',
  },
  {
    name: 'Journaling',
    goal: 'Develop a habit of reflection and self-expression through journaling.',
    recommendation: 'Use journaling for reflection, gratitude or tracking personal progress.',
    rule: 'A photo of a handwritten journal entry, every day.',
  },
  {
    name: 'Eating Fruits',
    goal: 'Improve daily nutrition by building a habit of eating fruits.',
    recommendation: 'Use fruits as a healthier alternative to reduce sweets.',
    rule: 'A photo of a fruit, every day.',
  },
  {
    name: 'Learn French',
    goal: 'Improve your French by practising writing consistently.',
    recommendation:
      "The best way to learn is active practice. If you can't free-write yet, copy from a resource until you are comfortable writing on your own.",
    rule: 'A photo of handwritten French text of at least 50 words, every day.',
  },
  {
    name: 'Pet Cat',
    goal: 'Spend quality time with your feline friend.',
    recommendation: 'Take a moment to relax and pet a cat.',
    rule: 'A photo of a cat, every day.',
  },
];
