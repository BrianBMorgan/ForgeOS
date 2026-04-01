# Intel Event Content Review

A full-featured event content management system built for Intel to manage conference session submissions, speaker profiles, and AI-powered content scoring.

**Live URL:** https://intel-event-content-review.forge-os.ai

---

## Overview

Intel Event Content Review streamlines the process of collecting, reviewing, and scoring session submissions for Intel events. The platform uses AI to evaluate submissions against event-specific criteria, helping content teams make data-driven decisions about which sessions to accept.

### Key Capabilities

- **Event Management** — Create and configure events with custom AI scoring profiles
- **Submission Tracking** — Collect and manage session proposals with full metadata
- **Multi-Speaker Support** — Associate multiple speakers with each submission
- **AI-Powered Scoring** — Automated 6-dimension scoring using Gemini 2.5 Pro
- **Abstract Enrichment** — AI-assisted abstract refinement aligned to event themes
- **Review Dashboard** — Ranked views, track-based grouping, and side-by-side comparison
- **Speaker Management** — Maintain speaker profiles with headshots and bios
- **CSV Export** — Export submissions for external analysis or reporting

---

## Features

### Events

- Create events with name, date, venue, and session slot count
- Define event context profiles (strategy, goals, KPIs, audience, content pillars)
- AI-generated scoring prompts tailored to each event's audience and themes
- Visual slot utilization tracking

### Submissions

- Comprehensive submission form with:
  - Title, Content Lead, Business Unit, Track
  - Format, Duration
  - Abstract (650 character limit, with 1000-character override option)
  - Key Topics, Demos, Featured Products
  - Business Challenge, Partner Highlights, New Launches
- Multi-speaker selection per submission
- Status workflow: Submitted → Under Review → Approved/Rejected/Needs Revision
- Reviewer notes field
- Search and filter by track, BU, status, or keyword

### AI Scoring

Each submission is evaluated on six dimensions (0-100 each):

| Dimension | What It Measures |
|-----------|------------------|
| **Federal Relevance** | Direct applicability to federal/defense/IC use cases |
| **Technical Depth** | Substance for technical buyers in cleared environments |
| **Intel Alignment** | Meaningful showcase of Intel silicon, software, or ecosystem |
| **Audience Fit** | Appropriate framing for senior government decision-makers |
| **Innovation Signal** | Genuinely new capabilities vs. known baselines |
| **Delivery Readiness** | Speaker credibility, format fit, and abstract clarity |

The AI returns:
- **Overall Score** (0-100)
- **Dimension Rationales** — Explanation for each score
- **Strengths** — What works well
- **Gaps** — Areas needing improvement
- **Recommendation** — Accept / Accept with Revisions / Decline

### Abstract Enrichment

One-click AI refinement that:
- Preserves the core technical message
- Improves clarity and impact
- Aligns language to the event's audience and themes
- Returns formatted HTML ready for publication

### Review Dashboard

- **Ranked View** — All scored submissions sorted by overall score
- **Track View** — Submissions grouped by track with per-track rankings
- **Compare View** — Select 2-3 submissions for side-by-side dimension comparison
- **Bulk Scoring** — Score all unscored submissions in one operation

### Speakers

- Full speaker profiles: name, title, company, email, bio
- Headshot upload with image preview
- Link speakers to multiple submissions
- Speaker names displayed in submission tables and exports

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js with Express.js |
| **Database** | Neon PostgreSQL (serverless) |
| **AI - Scoring** | Google Gemini 2.5 Pro |
| **AI - Profile Generation** | Anthropic Claude 3 Haiku |
| **Markdown** | Showdown |
| **File Uploads** | Multer (memory storage) |
| **Deployment** | ForgeOS → Render |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `GEMINI_API_KEY` | Yes | Google AI API key for Gemini |
| `PORT` | No | Server port (default: 3000) |

---

## Database Schema

### `events`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| name | TEXT | Event name |
| event_date | TEXT | Display date |
| venue | TEXT | Location |
| slot_count | INTEGER | Available session slots |
| context_profile | TEXT | JSON or text event context |
| ai_system_prompt | TEXT | Custom AI scoring instructions |
| created_at | TIMESTAMPTZ | Creation timestamp |

### `speakers`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| event_id | INTEGER | FK → events |
| full_name | TEXT | Speaker name |
| title | TEXT | Job title |
| company | TEXT | Organization |
| email | TEXT | Contact email |
| bio | TEXT | Biography |
| headshot | BYTEA | Image binary |
| headshot_mimetype | TEXT | Image MIME type |
| created_at | TIMESTAMPTZ | Creation timestamp |

### `submissions`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| event_id | INTEGER | FK → events |
| title | TEXT | Session title |
| content_lead | TEXT | Content owner |
| bu | TEXT | Business unit |
| track | TEXT | Content track |
| format | TEXT | Session format |
| duration | TEXT | Session length |
| abstract | TEXT | Session description |
| key_topics | TEXT | Topic tags |
| demos | TEXT | Demo details |
| featured_products | TEXT | Intel products highlighted |
| business_challenge | TEXT | Problem addressed |
| partner_highlights | TEXT | Partner involvement |
| new_launches | TEXT | New announcements |
| reviewer_notes | TEXT | Internal notes |
| status | TEXT | Workflow status |
| ai_score | JSONB | AI scoring results |
| enriched_abstract | TEXT | AI-refined abstract (HTML) |
| created_at | TIMESTAMPTZ | Creation timestamp |

### `submission_speakers` (Junction Table)
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| submission_id | INTEGER | FK → submissions |
| speaker_id | INTEGER | FK → speakers |

---

## Local Development

```bash
# Clone the repository
git clone https://github.com/BrianBMorgan/ForgeOS.git
cd ForgeOS
git checkout apps/intel-event-content-review

# Install dependencies
npm install

# Set environment variables
export APP_DATABASE_URL="postgres://..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="..."

# Start the server
node server.js
```

The app will be available at `http://localhost:3000`.

---

## Deployment

This app is deployed via ForgeOS to Render. Commits to the `apps/intel-event-content-review` branch automatically trigger a deploy.

### Render Configuration

- **Build Command:** `npm install`
- **Start Command:** `node server.js`
- **Environment:** Node.js
- **Health Check Path:** `/`

---

## API Endpoints

### Events
- `GET /api/events` — List all events
- `POST /api/events` — Create event
- `PUT /api/events/:id` — Update event
- `POST /api/events/generate-profile` — AI-generate event profile

### Submissions
- `GET /api/submissions?event_id=X` — List submissions for event
- `POST /api/submissions` — Create submission
- `PUT /api/submissions/:id` — Update submission
- `POST /api/submissions/:id/score` — Run AI scoring
- `POST /api/submissions/:id/enrich` — AI-enrich abstract
- `GET /api/submissions/export?event_id=X` — Export CSV

### Speakers
- `GET /api/speakers?event_id=X` — List speakers for event
- `POST /api/speakers` — Create speaker (multipart/form-data)
- `PUT /api/speakers/:id` — Update speaker
- `DELETE /api/speakers/:id` — Delete speaker
- `GET /api/speakers/:id/headshot` — Get headshot image

---

## UI Guide

### Navigation

The left sidebar provides access to:
1. **Events** — Manage events and their scoring profiles
2. **Submissions** — View, add, and score session proposals
3. **Review** — Analyze scored submissions and make decisions
4. **Speakers** — Manage speaker profiles

Use the **Current Event** dropdown at the bottom of the sidebar to switch between events.

### Abstract Character Limits

- Default limit: **650 characters**
- Override option: Check "Override (allow 1000 characters)" to extend the limit
- Live character counter shows current usage

### Scoring Workflow

1. Add submissions manually or import via the submission form
2. Navigate to **Submissions** tab
3. Click **Score** on individual submissions, or use **Score All Unscored** in the Review tab
4. View detailed scoring breakdowns by clicking **View** on any submission
5. Use the **Review** tab to compare and rank submissions

---

## License

Proprietary — Intel Corporation

---

## Support

For issues or feature requests, contact the ForgeOS team.
