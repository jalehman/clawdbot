---
name: apple-notes-honeycrisp
description: Manage Apple Notes via the `honeycrisp` CLI on macOS (list, search, show, add, update, append, delete, export notes). Use when a user asks Clawdbot to read, create, edit, or search Apple Notes.
homepage: https://github.com/mattjefferson/honeycrisp
metadata: {"clawdbot":{"emoji":"🍎","os":["darwin"],"requires":{"bins":["honeycrisp"]},"install":[{"id":"source","kind":"shell","command":"git clone https://github.com/mattjefferson/honeycrisp.git /tmp/honeycrisp && cd /tmp/honeycrisp && swift build -c release && cp .build/release/honeycrisp /usr/local/bin/","label":"Build honeycrisp from source"}]}}
---

# Apple Notes (honeycrisp)

Use `honeycrisp` to manage Apple Notes from the terminal.

## Setup

Build from source (requires Xcode/Swift):
```bash
git clone https://github.com/mattjefferson/honeycrisp.git
cd honeycrisp
swift build -c release
cp .build/release/honeycrisp /usr/local/bin/
```

On first use, honeycrisp will prompt for folder access to the Notes database. Grant access to `group.com.apple.notes` or `NoteStore.sqlite`.

For write operations (add/update/delete), macOS will ask for Automation access to Notes.app.

## List Notes

```bash
honeycrisp list
honeycrisp list --account iCloud
honeycrisp list --folder "Work"
honeycrisp list --json
honeycrisp list --accounts
honeycrisp list --folders --account iCloud
```

## Search Notes

```bash
honeycrisp search "grocery"
honeycrisp search "meeting" --folder "Work" --json
```

## Show/Read a Note

```bash
honeycrisp show "Grocery List"
honeycrisp show "Grocery List" --markdown
honeycrisp show "Grocery List" --json
honeycrisp show --id "x-coredata://..."
```

## Create a Note

```bash
honeycrisp add "New Note Title" "Body text here"
honeycrisp add "Shopping" --body "Milk, eggs, bread"
honeycrisp add "Meeting Notes" --folder "Work" --account iCloud
echo "Note content" | honeycrisp add "From Stdin"
```

## Update a Note

```bash
honeycrisp update "Grocery List" --body "New content"
honeycrisp update "Old Title" --title "New Title"
cat updated.txt | honeycrisp update "My Note"
```

## Append to a Note

```bash
honeycrisp append "Grocery List" "Add milk"
honeycrisp append "Shopping" --body "More items"
```

## Delete a Note

```bash
honeycrisp delete "Old Note"
honeycrisp delete "Untitled" --folder "Recently Deleted"
```

## Export a Note

```bash
honeycrisp export "Weekly Notes" --markdown
honeycrisp export "Meeting" --json
```

## Notes

- NOTE can be a CoreData id, numeric id, or exact title
- Use `--json` for structured/parseable output
- Use `--markdown` with show/export for markdown formatting
- Notes in "Recently Deleted" are excluded unless explicitly requested
- Reading uses direct database access; writing uses AppleScript
