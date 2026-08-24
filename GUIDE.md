# Job Desk — how to use it

## Start here: your resume

The first thing the app asks for is your resume. Press **Choose my resume…** and
pick the file. PDFs (`.pdf`), Word documents (`.docx`), plain text and Markdown
are all read directly.

One kind of PDF cannot be read: a scan, or a photograph of a printed page. There
are no words in a file like that, only a picture of words. The app tells you
plainly when that happens rather than showing you an empty CV. The same is true
of a password-protected PDF, and of the rare file whose fonts come out garbled —
in every one of those cases, use **Paste the text instead** on the same screen,
which works for absolutely any file.

From that one file the app works out:

- **Your details** — name, email, phone, where you are. These go into every
  document it makes and every company form it fills in, so you never type them
  again.
- **What to search for** — your job titles become the words it asks the job sites
  for, and your skills become the words that push a role up the list.

It then shows you everything it read, so you can correct anything it got wrong
before it saves. Nothing is stored until you press **This is right**.

You can replace the resume, or work the search words out again, at any time from
Settings.

## Then: your mailbox

So applications go out from your own address and replies come back to the inbox
you already check.

Settings → *Your mailbox*. The server details are filled in from your email
address already. Type the mailbox password, press **Save**, then **Check it
works**, then **Send myself a test**. If the test arrives with your CV attached,
you are finished setting up.

**Worth doing too, and also free:** Settings → *Job sites that need a key*.
Adzuna is free and is where most of the Indian jobs come from. Sign up at
developer.adzuna.com and paste in the two values it gives you. Without it the
board leans heavily towards remote-first companies abroad.

---

## What you get for free

Everything below works with no payment and no AI key at all.

| | |
|---|---|
| **Finding jobs** | Adzuna, Remotive, RemoteOK, Himalayas, Arbeitnow, USAJOBS, any company's own careers page on Greenhouse, Lever, Ashby or Workable, and any RSS or Atom feed |
| **Ranking them** | Every role scored out of 100 against your keywords, with the matching words shown |
| **Filtering** | Remote / hybrid / on-site, country, city, kind of role, minimum score, source |
| **Your CV as PDF and Word** | Generated from your details, properly laid out, and readable by employers' screening software |
| **Applying by email** | Sent from your own address with the CV attached, copied to your inbox |
| **Company application forms** | Opened inside the app, filled in from your details, with the CV attached to the upload box |
| **Tracking** | Every application, the exact CV that went out, the email that was sent, and where it stands |
| **Follow-ups** | Scheduled automatically, drafted from a template, sent when you say so |
| **Keywords** | Complete control over what the app searches for, boosts, and throws away |

In this mode, each application sends **your full CV** with a **template letter**
that already names the role and the employer and describes your background. It
leaves you one line in square brackets to write — one sentence on why *this*
role. The app will not let you send while that line is still there.

That is a perfectly respectable way to apply. Plenty of people apply exactly like
this.

---

## What an AI key adds

The app offers this once, right after it reads your resume, and **Skip for now**
there costs you nothing — everything above keeps working. You can add a key later
from Settings → *AI tailoring*, or change one you have already added, and the app
checks it against the service before saving so a mistyped key is caught
immediately rather than on your first application.

**Which service.** Three work, and you can switch at any time:

| | |
|---|---|
| **Google Gemini** | The default. Its free tier covers roughly 1,000 requests a day and needs no card — enough to tailor every application most people send. Get a key from aistudio.google.com. |
| **Anthropic Claude** | Prepaid, about ₹5 an application. The strongest results. |
| **OpenRouter** | One key, many models. Model names ending `:free` cost nothing but are rate limited hard and come and go. |

**A subscription is not an API key.** A Gemini Pro or Claude chat subscription is
a consumer product and does not include API access — the key comes from the
developer console instead, and Google's has its own separate free tier.

**What the service sees.** Tailoring sends your whole CV. Anthropic does not train
on it. Google's *free* tier may use it to improve its models, and its paid tier
does not. Most free OpenRouter models allow training. The app tells you which is
which next to the picker, so the choice is yours to make knowingly.

It changes three things:

**1. The CV is rewritten for each job.** Instead of the same master CV going to
everyone, it is reordered, reworded into the employer's own language, and trimmed
to what they actually asked for. Your dates, employers, degrees and session count
are locked and cannot be changed — only the emphasis and the wording.

**2. The email is written from the job description.** Specific to that role, in
your voice, referencing what the posting actually asks for. No placeholder line
to fill in.

**3. An honest read on whether you qualify.** It tells you what matches, what is
missing, and anything that blocks it — a licence you do not hold, a time zone
that will not work, a requirement you cannot meet. Keyword matching cannot see
any of that, so without a key the score is only ever "these words appeared".

It also writes your follow-up notes for you instead of using the template.

**What it costs.** Nothing at all on Gemini's free tier, within its daily limits.
On a paid service it is a few rupees an application, prepaid — when the credit
runs out it simply stops. The app also has its own monthly limit, set to $10 out
of the box, which it checks before every single request, and there is a cheaper
model in the same settings if you want to halve it.

You can add a key later, remove it at any time, and nothing else changes.

---

## Every day

**Today** is the front page: follow-ups that are due, drafts you have not
finished, and what has happened recently.

**Find new jobs** goes and looks. Two or three minutes the first time, less
afterwards. It also runs by itself every six hours while the app is open.

## Applying

On **Board**, each role shows a score and the words that earned it. Filter down
the left.

Press **Tailor & apply**. You get a CV, a letter, and the email ready to read.
Then either:

- **Send it now** — goes from your address with the CV attached
- **Fill in the company form** — opens their page inside the app. Press *Fill in
  your details*, then *Attach the CV*. Everything it filled is outlined in green.
  **Read it, then press their Submit button yourself** — the app never submits
  for you. Afterwards press *I have submitted it* so it gets logged.

Nothing is ever sent without you pressing something.

## Keeping track

**Applications** holds every role you have applied to, the exact CV file that
went out, and where it stands. Change the status as you hear back. Anything you
mark as answered stops being chased.

**Follow-ups** appear on the day they are due — about a week after you apply, and
again a fortnight later. Press *Write it for me*, read it, send it. Or snooze it,
or skip it.

## Making the results better

**Keywords** shapes the whole thing. The list starts from your resume, and from
then on it is yours.

- **Search words** are what the app asks the job sites for. These start as your
  own job titles, with the seniority stripped off so a mid-level advert still
  matches. Keep the list tight; vague words fill the board with things you would
  never apply to.
- **Things that raise the score** are not searched for, but push a role up the
  list when they appear in it. These start as your skills and the things your
  resume keeps coming back to. Add anything you specialise in.
- **Never show me these** throws a role away if the words appear in its title.
  Nothing is put here for you — it needs judgement the app does not have. Use it
  for jobs that look similar but need a different profession or a licence you do
  not have.

The number beside each word is how many roles it has matched, so you can see
which ones are earning their place.

**Changing your career direction?** Update your resume in Settings, then press
**Work out my search words again**. It rebuilds the list from the new resume —
and anything you added or adjusted by hand is kept exactly as you left it. Only
the words the app worked out itself are replaced.

## Where everything is kept

All of it is on this computer, in a folder you can open from Settings. Nothing
is uploaded anywhere except the job searches, the CV tailoring if you turn it on,
and the emails you choose to send. Every CV the app has made for you is kept, and
*Back everything up now* makes a copy you can put on a pen drive.

## Adding a company's careers page

Most employers publish through Greenhouse, Lever, Ashby or Workable. The board
name is the last part of their careers URL — `boards.greenhouse.io/lyrahealth`
is `lyrahealth`. Sources → *Check it first* asks the real API before saving, so
a wrong name is caught immediately rather than silently returning nothing.

## When something goes wrong

- **The board is empty.** You have not pressed *Find new jobs* yet, or the
  minimum score in Settings is too high.
- **Nothing from India.** The Adzuna keys are missing. They are free, and they
  are where most Indian listings come from.
- **A source shows red.** Company boards change their name when a company
  switches systems. The Test button on Sources says so in one click.
- **Email fails.** Settings → *Check it works* prints the actual SMTP error in
  plain language rather than a code.
- **A form will not fill.** Some pages build their fields after load, or hide
  them behind a login. Reload, then fill. Failing that, *Show me the CV file*
  and drag it in.
- **Your PDF will not read.** It is almost certainly a scan. Open it, select
  everything, copy, and use *Paste the text instead*.
- **Tailoring stops working.** Check Settings — a free tier can be rate limited
  at busy times, and the app says so rather than failing silently. Applications
  keep working on the template path meanwhile.
