# Share-sheet capture: setup guide

This is the no-terminal capture path.
Highlight or share something on iPhone or Mac, tap "Brain", and it lands in the evidence store as a `clipping` episode.
Nothing captures automatically; a clip exists only because you shared it.

The flow has three parts:

1. A Shortcut in the share sheet writes a small JSON file into an iCloud Drive folder.
2. iCloud syncs that folder between your devices on its own.
3. The sweeper (`npm run clippings:sweep`) moves waiting clips into the brain through `brain.mjs add-episode`, with the same scrub, exclusion, and dedupe guards as session ingestion.

## The inbox folder

The folder is `iCloud Drive/FuzzyBrain/inbox`.
The sweeper creates it on its first run, or you can create it yourself in Files or Finder.
Processed clips move to `inbox/processed`, and skipped ones (blank or excluded) move to `inbox/skipped`; nothing is ever deleted.
If your Mac uses "Optimize Mac Storage", right-click the `FuzzyBrain` folder in Finder and choose "Keep Downloaded" so clips are always readable locally.

## The clip format

Each clip is one JSON file with any of these fields, all optional:

```json
{
  "url": "https://example.com/article",
  "title": "The article title",
  "selection": "text you highlighted",
  "note": "your own words about why you kept it",
  "app": "Safari",
  "device": "iPhone",
  "captured_at": "2026-07-21T18:00:00Z"
}
```

A plain `.txt` file works too; its whole content becomes the note.
The `selection` is stored as quoted evidence with no speaker, and the `note` is stored as your words (speaker "Tony"), so recall and embeddings work over the meat of the clip.

## Shortcut 1: "Brain" (the instant one)

Open the Shortcuts app and create a new shortcut named `Brain`.
In the shortcut's info panel (the "i" or the shortcut settings), turn on "Show in Share Sheet" and accept Any input type.
Exact action names shift slightly between iOS versions; the recipe below is the shape to build.

Add these actions in order:

1. `Get URLs from Input`, with input set to Shortcut Input.
2. `Get Name`, with input set to Shortcut Input.
3. `Get Text from Input`, with input set to Shortcut Input (this carries highlighted text when you shared a selection).
4. `Format Date` on Current Date, with format set to ISO 8601 (include time).
5. `Dictionary` with keys `url` (the URLs result), `title` (the Name result), `selection` (the Text result), `device` (Device Name from Device Details, or just type it), and `captured_at` (the formatted date).
6. `Get Text from Input` on the Dictionary, which turns it into JSON text.
7. `Save File`, saving that text to `iCloud Drive/FuzzyBrain/inbox`, with "Ask Where to Save" turned off and the filename set to `clip-` followed by Current Date formatted as `yyyyMMdd-HHmmss`, with extension `.json`.

Because Shortcuts sync through iCloud, building this once puts it in the share sheet on your iPhone, iPad, and Mac.

## Shortcut 2: "Brain + note" (one extra line)

Duplicate `Brain` and rename the copy to `Brain + note`.
Add one action before the Dictionary: `Ask for Input` (text), with a prompt like "why keep this?".
Add the answer to the Dictionary under the key `note`.
Your note is the most valuable field in the clip; it is your own words, and it becomes speaker-"Tony" evidence.

Optional but good: on iPhone, bind `Brain + note` to the Action button (Settings, Action Button, Shortcut) and use dictation to capture thoughts while walking.

## Running the sweeper

Run it by hand any time:

```
npm run clippings:sweep
```

To make it run on its own (every 15 minutes and at login), create `~/Library/LaunchAgents/com.tony.fuzzy-brain-clippings.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tony.fuzzy-brain-clippings</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/minhthiennguyen/Desktop/fuzzy-brain && npm run clippings:sweep</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/minhthiennguyen/.fuzzy-brain/clippings-sweep.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/minhthiennguyen/.fuzzy-brain/clippings-sweep.log</string>
</dict>
</plist>
```

Then load it once:

```
launchctl load ~/Library/LaunchAgents/com.tony.fuzzy-brain-clippings.plist
```

The sweeper is idempotent (clips dedupe by content hash), so running it early, often, or twice is always safe.
A failed clip stays in the inbox and is retried on the next run.
