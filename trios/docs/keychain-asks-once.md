# Making the Keychain ask once

The symptom: macOS asks for the login-keychain password again and again, and
the night's work stops while it waits.

## What is actually happening

A keychain item carries an access-control list naming which programs may read
it. When a program that is not on that list asks, macOS puts up the password
dialog. `Always Allow` adds the program to the list — **the program that
asked**, identified by its code signature.

Two things follow, and they explain everything about this symptom.

**An ad-hoc signature has no identity.** Every build is a different program to
macOS, so `Always Allow` grants a binary that stops existing at the next build,
and the dialog returns. This repository does not have that problem — `build.sh`
signs the release with a persistent certificate and the designated requirement
is stable:

```
designated => identifier "com.browseros.trios" and certificate leaf = H"ae1cc8b1…"
```

A stable requirement is the precondition for `Always Allow` to hold. It is not
sufficient on its own.

**An item written by another program lists that program, not yours.** The keys
here were created at different times by different tools, so their lists do not
all name the current app. That is the remaining cause, and it is fixed once,
by hand, because it needs the login password — which no agent should ever be
given, and which is why this is a page of instructions rather than a script
that runs itself.

## The one-time fix

Run this in a terminal. It will ask for your login password once, and it is the
standard remedy for exactly this symptom:

```bash
security set-generic-password-partition-list -S apple-tool:,apple:,codesign: -s com.browseros.trios.model-keys -k "" ~/Library/Keychains/login.keychain-db
```

Then the same for the GitHub token:

```bash
security set-generic-password-partition-list -S apple-tool:,apple:,codesign: -s ai.browseros.trios -k "" ~/Library/Keychains/login.keychain-db
```

`-k ""` means "prompt me for the password"; typing it into the terminal history
is worse than typing it into the dialog.

If it still asks after that, the next `Always Allow` will stick, because the
signature it grants no longer changes between builds.

## The much simpler alternative

Put the key in `~/.trios/config.json`:

```json
{ "TRIOS_ZAI_API_KEY": "…", "TRIOS_OPENROUTER_API_KEY": "…" }
```

Both keys are present in that file today **with empty values**, which reads as
"no key" to every consumer while looking configured to anyone who opens it.
`resolvedAPIKey` consults it second, so one line there gives the swarm a source
that never involves the Keychain at all.

## What the app does about it

Nothing in a background path may raise a dialog. Both credential stores now
default `allowsInteraction` to `false`; a caller with a person in front of it —
a settings screen — opts in explicitly.

That default used to be `true`, so any caller that had not thought about it
could raise a dialog nobody was positioned to answer. The read then blocked on
securityd, hit its deadline, and armed a cooldown that made every *other*
keychain read report "nothing there" for a minute. One inattentive caller
disabled the Keychain for the whole process, and the provider key looked absent
while `security find-generic-password` found it from a terminal in one go.
