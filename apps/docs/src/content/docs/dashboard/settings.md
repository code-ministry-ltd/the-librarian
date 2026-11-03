---
title: Settings
description: A tour of every settings area — login, the briefing, the curator, tokens, devices, captures, backups, and updates.
---

The **Settings** menu (top right of the dashboard) gathers everything you configure
once and rarely touch again. This page walks through each area. The menu lists them
as **Dashboard, Auth, Primer, Curator, Tokens, Connect, Captures,** and
**Backups**.

![The Settings page (Auth tab)](../../../assets/screenshots/settings.png)

## Auth

**Settings → Auth** controls whether the dashboard requires you to sign in. It is
off by default and strongly recommended for any deployment reachable from the
internet. A status strip shows the current state and which sign-in methods are set
up.

Setting it up is two steps. **First, add at least one sign-in method** — a username
and password, and/or GitHub or Google login (the page shows the exact callback URL
to register for each). **Then turn enforcement on.** Once enabled, every dashboard
page asks an unrecognised visitor to sign in, and the change takes effect
immediately with no redeploy. If you ever lock yourself out, you can recover from
the server's command line — see
[Authentication & secrets](/deploy-and-operate/auth-and-secrets/).

## Primer

The **primer** is the briefing every agent receives when it connects. It teaches the
core habits: recall before answering, what is worth remembering, flagging wrong memories,
handoffs, and private mode. It has two parts:

- **The default** ships with The Librarian and is the same on every install. You can't
  edit or turn it off, and it updates when you upgrade. The page shows it, and you can
  also read it on the [primer reference page](/reference/primer/).
- **Your addendum** is optional text added after the default, for anything specific to
  how you work. It is stored as `vault/primer.md`, and every save is tracked in history.

**Settings → Primer** edits the addendum and shows the complete primer agents will
receive, updating as you type. The whole primer must fit in 2 KB, because some harnesses
(Claude Code among them) cut server instructions off there, so the page shows how much
room the addendum has. Keep it generic guidance and never put secrets in it. The primer
is served to agents and can be read without a token.

Before version 1.47.0, the primer was a single document that your edits replaced. On
upgrade, a primer you never edited is cleared and the new default takes over. A primer
you did edit is moved into the addendum, so agents get the default followed by your old
text, and the page asks you to review it, because it probably repeats parts of the
default. Trim it to what the default doesn't say, then save.

Every recall an agent makes by search also ends with one line asking it to `remember`
the answer if it had to find it some other way, so the next recall finds it. That line
is part of the server, not the primer, and applies whatever your primer says.

## Curator

**Settings → Curator** is where you configure the curator's language model and when
it runs. At the top you manage **LLM providers** — add a provider (such as
Anthropic or OpenAI) with its credentials, **test** the connection, and edit or
remove it. Below that are two tabs: **Intake** files submissions and **Grooming**
tends the existing collection. Each tab contains its schedule or trigger controls,
model selection (with the job's **output limit** and **thinking level**), run
history, and a **Run now** button.

The Intake tab also holds the **Journal** settings: whether to keep a dated
journal of captured conversations, and how much of it agents get at the start of
a session. The journal's switch is independent of intake's: either one turns
capture on, and the journal uses the intake model. See
[The journal](/guides/journal/).

Below it, **Import** sets the limits on `librarian import`, which sends conversations
from before you set up The Librarian through intake and the journal. It shows the two
cutoffs, which are read-only, and how many conversations the server has recorded. It
also has two settings: the **maximum age** of a conversation that may be imported, and
the **allowance**, the number of conversations imports may still send. See
[Import past conversations](/guides/importing-conversations/).

For the bigger picture — what the two jobs do and how to tune them — see
[Configuring the curator](/guides/configuring-the-curator/).

## Tokens

**Settings → Tokens** manages the **agent tokens** your tools use to authenticate.
Generate a token with a label; its secret value is shown **once**, so copy it into
your tool's config right away. The table of active tokens lets you **revoke** any of
them, which takes effect immediately. Minting a token per agent (rather than sharing
one) is the recommended approach — it lets you attribute and revoke per tool.

## Connect

**Settings → Connect** helps you feed The Librarian from places other than a coding
agent — a **browser extension**, an **iPhone/iPad Shortcut**, and an **Android**
recipe — so you can clip an article or page into your references from anywhere. It
walks you through installing each, mints the **capture token** they need (shown
once), and shows the server URL to paste in. A table lists the capture tokens you
have issued, each with a **Revoke** button.

## Captures

**Settings → Captures** is a read-only log of those clip-from-a-device attempts. It
shows recent captures with their time, source URL, and status; successful ones link
to the reference that was filed, and failed ones show a (redacted) error and the
source so you can try again by hand. It also flags how many recent captures failed.

## Backups

**Settings → Backups** drives backing up your vault to a private GitHub repository.
A health strip shows when the last backup succeeded (or the error if it failed). You
configure the target repository and its credentials, can **Backup now** on demand,
and see a short history of recent backups. A **restore** section explains how to
pull the latest backup back in. Backups and restores are walked through end-to-end
in [Backups & restore](/guides/backups-restore/).

## Dashboard

**Settings → Dashboard** holds instance-level options: the **read log**, **notices** and
**server auto-update**.

**Read log** records what agents read: every recall and reference search, and the primer and
journal each session receives. It's off by default and takes effect as soon as you tick it.
Read it on the [Logs](/dashboard/logs/) page; what it records is described in
[Seeing what agents read](/deploy-and-operate/self-host/#seeing-what-agents-read).

**Notices** are short messages for whoever runs the Librarian, behind the bell beside the
version number at the top of every page. The bell shows how many are unread, and a security
notice is called out in words. Some notices come from this server itself, such as a request to
review your primer addendum after an upgrade. Others are published by the project in
`notices.json` on GitHub, so they can reach an install that hasn't been upgraded yet, for
example to warn about a security problem in an older version. The switch here turns off that
fetch. What the fetch sends is described in
[Network calls the server makes](/deploy-and-operate/self-host/#network-calls-the-server-makes).

**Server auto-update**: the toggle and cadence (daily or weekly) are *settings*: they tell
the host's update timer what to do, but the dashboard cannot perform an update
itself — a server can't recreate its own container from inside it. Auto-update
actually runs once the host timer is installed, on the machine running the
server, as the user who ran `server up`:

```sh
librarian server autoupdate enable
```

The page also shows the current version, the latest available, and when
auto-update last ran. The full walkthrough — including what to check when
auto-update seems to do nothing — is in
[Automatic updates](/deploy-and-operate/self-host/#automatic-updates).
