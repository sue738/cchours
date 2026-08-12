# ⏱ cchours

**How many hours did your AI actually run?**

```bash
npx cchours
```

Every Claude Code usage tool counts tokens, dollars, or quota percent. None of
them answer the question you actually ask yourself at the end of a month: *how
much machine time did I run?* On a subscription the dollar figure is fictional
and tokens don't map to anything you can feel — hours do.

```
╭──────────────────╮
│  cchours — monthly  │
╰──────────────────╯
┌──────────┬──────────┬───────────┬──────────┬───────────┬───────────┐
│ month    │ observed │ agent-hrs │  per 30d │ person-mo │ subagents │
├──────────┼──────────┼───────────┼──────────┼───────────┼───────────┤
│ 2026-07  │      24d │   215h36m │  264h34m │      1.65 │   120h10m │
│ 2026-08* │      10d │    67h50m │  194h52m │      1.22 │    24h43m │
└──────────┴──────────┴───────────┴──────────┴───────────┴───────────┘
```

The number that surprised its author: **subagents were 51% of all hours.** No
token dashboard shows you that, because subagent transcripts live in a separate
directory most tools never walk.

## Share it

```bash
npx cchours --card
```

```
cchours — last 30 days

   249h51m
   of AI runtime

   ███████████░░░░░░░░░ 54%  run by subagents

   1.8 agents in parallel · 140h40m wall-clock

   npx cchours
```

Text, not an image — it pastes into X, Slack, Discord or a PR description with
no upload and no hosting. `--svg` renders the picture version: your month as a
30-day × 24-hour heatmap in contribution-graph green. Night work lights up the
bottom rows; crunch days stand as full columns. Every card is personal.

<p align="center">
  <img src="https://raw.githubusercontent.com/sue738/cchours/main/docs/card.svg" width="480" alt="cchours share card — a 30-day × 24-hour heatmap of AI runtime">
</p>

The card is always the **last 30 days**, whatever your history looks like, so
two cards can be compared. (`--card --all` if you want your whole archive; if
your history is shorter than 30 days the card says so.)

## Usage

```bash
npx cchours                  # run without installing
npm install -g cchours       # or make it a command: cchours
```

```bash
npx cchours                  # daily table
npx cchours --monthly        # per month, normalised to a 30-day rate
npx cchours --week           # last 7 days
npx cchours --by-project     # which project ate the hours
npx cchours --card           # shareable card
npx cchours --svg card.svg   # card as an image
npx cchours --caps           # the same period at several idle caps
npx cchours --json           # for your own scripting
npx cchours --since 20260701 --until 20260731
```

## How the time is measured (and why it won't flatter you)

An hour count is only worth anything if it's honest, and every easy mistake
inflates it.

**Silence is not work.** The obvious method — "you asked at 10:00, the agent
finished at 10:40, so 40 minutes" — counts every minute the agent sat blocked on
a permission prompt. Measured on one real session that method claimed **10.97h
where the real work was 4.39h**. Instead cchours sums the gaps *between
consecutive log entries* and discards any gap longer than 60s. A working agent
writes every few seconds (measured across real transcripts: median 3.4s, p95
42s), so a minute of silence means it stopped — waiting on you, or dead.

**No single cap is "the truth."** Idle-capping is the standard approach for
activity logs (WakaTime uses 5 min, RescueTime 15). `--caps` prints the same
period at 30s/60s/2m/5m/10m/15m so you can see how much of the number is the
threshold's opinion rather than yours.

**Nothing is counted twice.** Overlapping activity inside one agent is merged
before summing. A transcript with a single timestamp contributes zero, never a
guessed "typical turn."

**Parallel agents do add up** — two agents working the same minute is two
agent-minutes, which is exactly what a human team would cost. Wall-clock time
(the union across all agents) is always printed next to it, and their ratio is
your real parallelism, so the two can never be confused.

`person-month = 8h × 20d = 160h` of *machine* time. It is a readability
convention, stated so you can disagree with it — not a claim about output.

## Honest limitations

- **Your history is shorter than you think.** Claude Code deletes transcripts
  after `cleanupPeriodDays` (default 30), so "all time" means "what survived."
  Raise it in `~/.claude/settings.json` before you care about the number.
- A tool that runs 10 minutes while the agent writes nothing (a long build, a
  sleeping poll) counts as stopped. cchours undercounts rather than guesses.
- `--idle-gap N` moves the silence threshold. It's a knob for accuracy, not a
  dial for bigger numbers.
- The 00–06h share is local-clock, not proof you were asleep.

## Related

[`ccusage`](https://github.com/ccusage/ccusage) for tokens and cost ·
[`agent-hours`](https://github.com/pmochine/agent-hours) if you bill clients for
them · [`cc-agent-load`](https://github.com/yurukusa/cc-agent-load) for a
you-vs-AI ratio.

## Security & trust

- Zero dependencies, no postinstall, no network, no telemetry.
- Reads `~/.claude/projects`, writes nothing (except an `--svg` file you name).
- ~600 lines, all of it in `lib/`. Read it before you run it:
  `git clone <repo> && node cchours/bin/cchours.js`

## License

MIT
