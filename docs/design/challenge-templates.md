# Challenge templates (carried over from the Gemini app)

The owner's Gemini build offered seven preset challenges. In the rebuild they are the **only** way to make a challenge (owner's decision, 2026-10-19: no custom challenges or rules in the first draft). Picking one sets the title and rule of a new private challenge (PRODUCT.md story 2.1), and its AI instruction seeds the AI check prompt (story 6.1, plan Step 7). The creator picks the schedule, length, stake and misses; the title and rule can't be edited. The live texts are in the `challenge_templates` table (migration `20261019230000_template_only_challenges.sql`).

Text below is copied from the Gemini app (`challengeDescriptions` in `App.tsx` and `verifyProof` in `geminiService.ts`), lightly tidied.

| Template | Goal | Recommendation | What counts (acceptance) | AI instruction (seed) |
|---|---|---|---|---|
| **Pet Cat** | Spend quality time with your feline friend | Take a moment to relax and pet a cat | A photo of a cat, daily | The photo must contain a cat. Reject reason: "No cat detected, please take a clearer photo." |
| **Workout** | Stay active daily | Building a daily habit of working out includes stretching and recovery. Alternate between lifting, HIIT, cardio, stretching and recovery to avoid fatigue and injury | A photo taken in a gym or any workout environment, daily | The photo must be in a gym or workout environment. Reject reason: "No gym detected, please take a clearer photo." |
| **Read a Book** | Build a consistent reading habit and improve focus by spending dedicated time each day reading a book | Choose a book you enjoy and aim to read in a distraction-free environment | A photo of an open book you are currently reading, daily | The photo must contain an open book. Reject reason: "No open book detected, please take a clearer photo." |
| **Sunshine** | Encourage spending time outdoors daily to support mental well-being, energy levels and routine | Getting sunlight first thing in the morning is ideal | A photo taken outdoors during daytime, daily | The photo must be taken outdoors in daylight with the outdoors clearly visible; cloudy is fine if it is daytime. Reject reason: "Not clearly outdoors during daytime, please take a clearer photo." |
| **Journaling** | Develop a habit of reflection and self-expression through journaling | Use journaling for reflection, gratitude or tracking personal progress | A photo of a handwritten journal entry, daily | The photo must contain a handwritten journal entry. Reject reason: "No handwritten journal entry detected, please take a clearer photo." |
| **Eating Fruits** | Improve daily nutrition by building a habit of eating fruits | Use fruits as a healthier alternative to reduce sweets | A photo of a fruit, daily | The photo must contain a fruit. Reject reason: "No fruit detected, please take a clearer photo." |
| **Learn French** | Improve your French by practising writing consistently | The best way to learn is active practice. If you can't free-write yet, use resources or copy for guidance until you are comfortable writing on your own | A photo of handwritten French text, daily, at least 50 words. A new suggested topic each day | The photo must contain handwritten French text of at least 50 words. Reject reason: "Handwritten French text of at least 50 words not detected, please take a clearer photo." |

Custom challenges (no template) used a generic instruction: *Analyze whether the image proves the task "{rule}" was completed.* Custom challenges are out of the first draft, so this instruction is not used. All prompts asked the model to be "strict but fair" and return `approved` plus a one-line reason. The rebuild's AI check must return the spec's three verdicts (likely okay / unsure / likely not okay), with unsure counting as rejected.

## Learn French: daily topics (30, cycling by day number)
1. Introduce yourself and your family.
2. Describe your favorite food and why you like it.
3. Talk about your hobbies and what you do in your free time.
4. Describe your daily routine.
5. Write about a memorable trip or vacation.
6. Talk about your favorite movie or book.
7. Describe your dream job.
8. Write a short story about a pet.
9. Discuss the weather and your favorite season.
10. Write a letter to a friend.
11. Describe your hometown.
12. Talk about your future goals.
13. Write about a historical event.
14. Describe a typical weekend.
15. Talk about a sport you enjoy.
16. Write about your favorite music genre.
17. Describe a festival or celebration.
18. Talk about your school or work.
19. Write about a famous person you admire.
20. Describe your favorite childhood memory.
21. Talk about a skill you want to learn.
22. Write about a recent news event.
23. Describe your ideal house.
24. Talk about a challenge you overcame.
25. Write about your favorite animal.
26. Describe a place you want to visit.
27. Talk about a technological invention.
28. Write about a cultural tradition.
29. Describe a funny incident.
30. Talk about your favorite subject in school.
