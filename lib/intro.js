const Anthropic = require('@anthropic-ai/sdk');

// Accept common name/casing variants so dashboard entry mismatches don't break deploys
process.env.APIFY_TOKEN =
  process.env.APIFY_TOKEN || process.env.Apify_Token || process.env.APIFY_API_TOKEN || '';
process.env.ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || process.env.Anthropic_API_Key || '';

const APIFY_ACTOR = 'harvestapi~linkedin-profile-scraper';
const MODEL = 'claude-haiku-4-5'; // low-cost model per project requirement

const LINKEDIN_RE = /^https?:\/\/(www\.)?linkedin\.com\/in\/[^\s/]+\/?([?#].*)?$/i;

function normalizeLinkedInUrl(raw) {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!LINKEDIN_RE.test(url)) return null;
  return url.split(/[?#]/)[0];
}

// --- Apify: scrape one LinkedIn profile (async run + poll, surfaces run errors) ---
async function scrapeProfile(url) {
  const token = encodeURIComponent(process.env.APIFY_TOKEN);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1. Start the run
  const startResp = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }
  );
  if (!startResp.ok) {
    const text = await startResp.text().catch(() => '');
    throw new Error(`Apify wouldn't start the scrape (${startResp.status}): ${text.slice(0, 300)}`);
  }
  const run = (await startResp.json()).data;

  // 2. Poll until the run reaches a terminal state (max ~4 min)
  const deadline = Date.now() + 240 * 1000;
  let status = run.status;
  let statusMessage = '';
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() > deadline) throw new Error('Profile scrape timed out after 4 minutes');
    await sleep(4000);
    const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
    if (!poll.ok) continue;
    const data = (await poll.json()).data;
    status = data.status;
    statusMessage = data.statusMessage || '';
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run ${status}${statusMessage ? `: ${statusMessage}` : ''}`);
  }

  // 3. Fetch the results
  const itemsResp = await fetch(
    `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true`
  );
  if (!itemsResp.ok) throw new Error(`Couldn't read scrape results (${itemsResp.status})`);
  const items = await itemsResp.json();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      `Scrape finished but returned no data${statusMessage ? ` (${statusMessage})` : ''} — check the profile URL`
    );
  }
  return items[0];
}

// --- Trim the raw Apify payload down to what the LLM needs ---
function slimProfile(p) {
  const el = p?.element || p; // harvestapi sometimes nests under "element"
  const pick = (obj, keys) => {
    const out = {};
    for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') out[k] = obj[k];
    return out;
  };
  const mapList = (list, keys, max = 10) =>
    Array.isArray(list) ? list.slice(0, max).map((item) => pick(item, keys)) : undefined;

  const slim = {
    name:
      el.firstName && el.lastName
        ? `${el.firstName} ${el.lastName}`
        : el.fullName || el.name,
    headline: el.headline,
    location: el.location?.linkedinText || el.location?.text || el.location,
    about: typeof el.about === 'string' ? el.about.slice(0, 2500) : undefined,
    currentPosition: el.currentPosition,
    experience: mapList(el.experience, [
      'position', 'title', 'companyName', 'company', 'duration', 'employmentType',
      'location', 'description',
    ]),
    education: mapList(el.education, [
      'schoolName', 'school', 'degree', 'fieldOfStudy', 'period', 'duration',
    ]),
    skills: Array.isArray(el.skills)
      ? el.skills.slice(0, 30).map((s) => s.name || s)
      : undefined,
    certifications: mapList(el.certifications, ['title', 'name', 'issuedBy'], 8),
    volunteering: mapList(el.volunteering || el.volunteerExperience, [
      'role', 'organization', 'cause', 'description',
    ], 6),
    languages: Array.isArray(el.languages)
      ? el.languages.slice(0, 8).map((l) => l.name || l.language || l)
      : undefined,
    honors: mapList(el.honorsAndAwards || el.honors, ['title', 'issuedBy'], 6),
    publications: mapList(el.publications, ['title', 'publisher'], 5),
  };
  // Drop empty keys
  for (const k of Object.keys(slim)) {
    const v = slim[k];
    if (v == null || (Array.isArray(v) && v.length === 0)) delete slim[k];
  }
  return slim;
}

// --- Claude: find similarities + draft three intro emails ---
async function generateIntro(profileA, profileB, purpose) {
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const schema = {
    type: 'object',
    properties: {
      similarities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Genuine points of common ground between the two people',
      },
      emails: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            style: { type: 'string', description: 'Short label, e.g. "Warm & personal"' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['style', 'subject', 'body'],
          additionalProperties: false,
        },
      },
    },
    required: ['similarities', 'emails'],
    additionalProperties: false,
  };

  const purposeLine = purpose
    ? `\nThe sender's stated purpose for the introduction: ${purpose}`
    : '';

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: `You help someone write an email introducing two people from their network to each other.

First, find GENUINE similarities between the two LinkedIn profiles: shared employers, schools, industries, skills, causes, locations, career paths, interests. Only include real overlaps found in the data — never invent or stretch. Write 4-8 concise bullet points, each naming the specific shared thing.

Then write exactly 3 short intro emails, each in a distinct style:
1. "Warm & personal" — friendly, conversational
2. "Professional & direct" — crisp, businesslike
3. "Brief & punchy" — 3-4 sentences max

Best practices for every draft:
- Addressed to both people (e.g. "Hi {FirstA} and {FirstB}").
- Under 150 words. State clearly why you're connecting them.
- One-line credibility intro for each person (what they do, one impressive specific).
- Name the common ground so the intro feels natural, not forced.
- End with a light handoff ("I'll let you two take it from here") and sign off with [Your Name].
- No flattery padding, no "I hope this email finds you well".
- Use only facts from the profiles. Use each person's real first name.`,
    messages: [
      {
        role: 'user',
        content:
          `PERSON A:\n${JSON.stringify(profileA, null, 1)}\n\n` +
          `PERSON B:\n${JSON.stringify(profileB, null, 1)}` +
          purposeLine,
      },
    ],
    output_config: { format: { type: 'json_schema', schema } },
  });

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Model returned no text');
  return JSON.parse(text);
}

// --- Full request handler, shared by local Express and Vercel ---
// Returns { status, payload } — never throws.
async function handleGenerate(body) {
  try {
    const url1 = normalizeLinkedInUrl(body?.url1);
    const url2 = normalizeLinkedInUrl(body?.url2);
    const purpose = typeof body?.purpose === 'string' ? body.purpose.trim().slice(0, 500) : '';

    if (!url1 || !url2) {
      return { status: 400, payload: { error: 'Enter two valid LinkedIn profile URLs (linkedin.com/in/...)' } };
    }
    if (url1.toLowerCase() === url2.toLowerCase()) {
      return { status: 400, payload: { error: 'The two URLs must be different people' } };
    }
    if (!process.env.APIFY_TOKEN) {
      return { status: 500, payload: { error: 'Server missing APIFY_TOKEN environment variable' } };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return { status: 500, payload: { error: 'Server missing ANTHROPIC_API_KEY environment variable' } };
    }

    // Scrape both profiles in parallel
    let rawA, rawB;
    try {
      [rawA, rawB] = await Promise.all([scrapeProfile(url1), scrapeProfile(url2)]);
    } catch (err) {
      console.error('Apify error:', err.message);
      return { status: 502, payload: { error: `Couldn't fetch a LinkedIn profile. ${err.message}` } };
    }

    const profileA = slimProfile(rawA);
    const profileB = slimProfile(rawB);
    if (!profileA.name || !profileB.name) {
      return { status: 502, payload: { error: "One of the profiles came back empty — check the URLs and try again." } };
    }

    const result = await generateIntro(profileA, profileB, purpose);

    return {
      status: 200,
      payload: {
        personA: { name: profileA.name, headline: profileA.headline || '' },
        personB: { name: profileB.name, headline: profileB.headline || '' },
        similarities: result.similarities,
        emails: result.emails,
      },
    };
  } catch (err) {
    console.error('Generate error:', err);
    return { status: 500, payload: { error: err.message || 'Something went wrong' } };
  }
}

// --- Naive per-IP rate limit: 10 generations per 10 minutes ---
// Best effort on serverless (state is per warm instance).
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (recent.length >= 10) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

module.exports = { handleGenerate, isRateLimited };
