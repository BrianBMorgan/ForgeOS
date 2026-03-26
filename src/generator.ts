import { BrandBrief, VisualIdentity, HomepageDirection, VoiceStudio, AlignmentReport } from './types';

export function generateVisualIdentity(brief: BrandBrief): VisualIdentity {
  const traits = brief.personality.traits;
  const aesthetic = brief.visual.aesthetic;
  
  return {
    brandTraits: [
      ...traits,
      `${aesthetic[0]} foundation with purposeful ${aesthetic[1].toLowerCase()} elements`,
      `Reflects ${brief.icp.psychographics[0].toLowerCase()}`
    ],
    fontDirection: {
      primary: "Inter or similar geometric sans-serif for body text — optimized for screen readability and data-dense interfaces",
      secondary: "A medium-weight variant for headings that conveys authority without heaviness",
      rationale: `${brief.company.name} serves ${brief.icp.role.split(' at ')[0]}s who process significant amounts of information. Typography must balance density with clarity, projecting ${traits[0].toLowerCase()} competence.`
    },
    colorPalette: [
      {
        name: "Foundation",
        hex: brief.visual.colors.primary,
        usage: "Primary backgrounds, text on light surfaces, navigation elements"
      },
      {
        name: "Intelligence Blue",
        hex: brief.visual.colors.secondary,
        usage: "Interactive elements, key actions, data visualization accents"
      },
      {
        name: "Success",
        hex: brief.visual.colors.accent,
        usage: "Positive indicators, growth metrics, confirmation states"
      },
      {
        name: "Surface Light",
        hex: "#F8FAFC",
        usage: "Card backgrounds, content areas, breathing space"
      },
      {
        name: "Border Subtle",
        hex: "#E2E8F0",
        usage: "Dividers, input borders, subtle separation"
      },
      {
        name: "Text Secondary",
        hex: "#64748B",
        usage: "Supporting text, metadata, captions"
      }
    ],
    uiShapes: {
      borderRadius: "6-8px",
      style: "Slightly rounded — professional but approachable, never sharp or pill-shaped",
      rationale: `Sharp corners feel cold and dated. Pills feel playful and consumer-focused. Moderate rounding (6-8px) projects the ${traits[3].toLowerCase()}, ${traits[4].toLowerCase()} positioning ${brief.company.name} requires.`
    },
    layoutPrinciples: [
      "Grid-based composition with 8px baseline grid",
      "Generous whitespace — let content breathe",
      "Clear visual hierarchy through size and weight, not decoration",
      "Consistent spacing rhythm (16px, 24px, 32px, 48px)",
      "Content-first layouts that surface insights immediately",
      "Progressive disclosure for complex information"
    ],
    imageryDirection: [
      "Abstract data visualizations over stock photography",
      "Clean product UI screenshots showing real value",
      "Geometric patterns suggesting precision and structure",
      "Avoid: generic business imagery, handshakes, skylines"
    ],
    motionDirection: [
      "Subtle and purposeful — motion should inform, not decorate",
      "Fast transitions (150-200ms) for immediate feedback",
      "Ease-out curves for elements entering view",
      "Reduced motion support for accessibility",
      "No parallax, no dramatic reveals, no bounce effects"
    ],
    antiPatterns: [
      ...brief.personality.antiPatterns.map(p => `Visual equivalent: ${p}`),
      "Neon colors or cyberpunk aesthetics",
      "Excessive gradients or glossy effects",
      "Cluttered interfaces with competing focal points",
      "Generic SaaS illustration styles"
    ],
    designRationale: `${brief.company.name} targets ${brief.icp.role}s who ${brief.icp.psychographics[2].toLowerCase()}. The visual system must project ${traits.slice(0, 3).join(', ').toLowerCase()} authority while remaining warm enough to feel approachable. Every design decision traces back to the core positioning: "${brief.positioning.differentiation.split('.')[0]}." This means favoring clarity over complexity, substance over style, and confidence over flash.`
  };
}

export function generateHomepageDirection(brief: BrandBrief): HomepageDirection {
  return {
    heroHeadline: `${brief.company.tagline.charAt(0).toUpperCase() + brief.company.tagline.slice(1)}`,
    heroSubheadline: brief.positioning.differentiation,
    ctaOptions: {
      primary: "See it in action",
      secondary: "Talk to an expert"
    },
    sectionArchitecture: [
      { name: "Hero", purpose: "Immediate clarity on what we do and who we serve", order: 1 },
      { name: "Problem Agitation", purpose: "Validate the pain points your ICP experiences daily", order: 2 },
      { name: "Solution Overview", purpose: "High-level view of how the platform works", order: 3 },
      { name: "Key Capabilities", purpose: "3-4 core features that deliver on the promise", order: 4 },
      { name: "Social Proof", purpose: "Logos, testimonials, or metrics that build trust", order: 5 },
      { name: "Product Glimpse", purpose: "Screenshot or demo that shows the actual UI", order: 6 },
      { name: "Differentiation", purpose: "Why us vs. alternatives (without naming competitors)", order: 7 },
      { name: "Final CTA", purpose: "Clear next step with reduced friction", order: 8 }
    ],
    visualStyle: [
      "Clean, grid-based layout with ample whitespace",
      "Hero with subtle gradient or solid color background",
      "Product screenshots as primary visual evidence",
      "Icons should be simple line-style, not illustrated",
      "Data visualizations to reinforce intelligence positioning"
    ],
    contentBlocks: {
      socialProof: [
        `"${brief.company.name} gave us visibility we never had before." — VP Marketing`,
        "Trusted by 200+ B2B marketing teams",
        "4.8/5 on G2 for ease of implementation"
      ],
      productProof: [
        "Live dashboard showing unified metrics",
        "Before/after comparison of data fragmentation",
        "Time-to-insight metrics (hours → minutes)"
      ],
      featureFraming: [
        `Unified Intelligence — ${brief.icp.painPoints[0].replace(/^[A-Z]/, c => c.toLowerCase()).replace(/\.$/, '')}? See everything in one view.`,
        `Actionable Insights — Move from data to decisions in minutes, not days.`,
        `Attribution You Can Trust — ${brief.icp.goals[3]}.`
      ]
    }
  };
}

export function generateVoiceStudio(brief: BrandBrief): VoiceStudio {
  return {
    voiceAttributes: [
      `${brief.personality.tone[0]} — we know our value without overselling`,
      `${brief.personality.tone[1]} — complexity should feel simple`,
      `${brief.personality.tone[2]} — professional but human`,
      `${brief.personality.tone[3]} — informed but accessible`
    ],
    writingRules: [
      "Lead with the outcome, then explain the how",
      "Use 'you' more than 'we' — customer-centric framing",
      "Prefer active voice over passive constructions",
      "One idea per sentence, one theme per paragraph",
      "Quantify claims whenever possible",
      "Avoid superlatives unless backed by data"
    ],
    wordsToUse: [
      "clarity", "unified", "intelligence", "insights", "strategic",
      "precision", "visibility", "confidence", "impact", "growth",
      "streamlined", "actionable", "trusted", "measurable"
    ],
    wordsToAvoid: [
      "synergy", "leverage", "revolutionary", "disruptive", "game-changing",
      "cutting-edge", "best-in-class", "world-class", "seamless", "robust",
      "empower", "unlock", "supercharge", "turbocharge"
    ],
    sampleHeadlines: [
      "Finally, marketing intelligence that makes sense",
      "See your entire marketing ecosystem in one view",
      "Stop guessing. Start knowing.",
      "The clarity your marketing team deserves",
      `${brief.company.name}: Where data becomes direction`
    ],
    sampleProductCopy: [
      `${brief.company.name} brings together data from every marketing tool you use, synthesizing signals into clear, actionable insights. No more dashboard juggling. No more spreadsheet archaeology.`,
      "Your team spends 40% of their time gathering data. What if that time went to strategy instead?",
      "Connect once, see everything. Our platform integrates with 50+ marketing tools to give you the unified view you've been building manually."
    ],
    sampleCTAs: [
      "See it in action",
      "Get a demo",
      "Start your free trial",
      "Talk to our team",
      "Explore the platform"
    ],
    beforeAfter: {
      before: "Our revolutionary AI-powered platform leverages cutting-edge technology to seamlessly empower your marketing team with game-changing insights that will disrupt how you think about data.",
      after: "Get clear answers from your marketing data in minutes, not hours. One platform. Every signal. Actionable insights.",
      explanation: "The 'before' version relies on empty buzzwords and vague promises. The 'after' version leads with a concrete benefit (speed), states what the product does (unifies data), and ends with the outcome (insights). It respects the reader's intelligence and time."
    }
  };
}

export function generateAlignmentReport(brief: BrandBrief): AlignmentReport {
  // Simulate scoring based on brief completeness and coherence
  const hasCompleteBrief = brief.company.name && brief.icp.role && brief.positioning.differentiation;
  const hasStrongPersonality = brief.personality.traits.length >= 4;
  const hasVisualDirection = brief.visual.aesthetic.length >= 3;
  const hasClearPositioning = brief.positioning.uniqueValue.length > 50;
  const hasDifferentiation = brief.positioning.competitors.length >= 2;

  return {
    scores: {
      icpFit: hasCompleteBrief ? 87 : 65,
      positioningClarity: hasClearPositioning ? 92 : 70,
      visualCoherence: hasVisualDirection ? 85 : 60,
      voiceConsistency: hasStrongPersonality ? 88 : 72,
      differentiation: hasDifferentiation ? 83 : 55
    },
    matches: [
      "Visual identity strongly reflects the 'intelligent' and 'precise' brand traits",
      "Homepage messaging directly addresses documented ICP pain points",
      "Voice guidelines successfully avoid all specified anti-patterns",
      "Color palette supports the premium, trustworthy positioning",
      "Typography direction aligns with data-dense interface needs"
    ],
    drifts: [
      "Homepage hero could more explicitly call out the target role",
      "Some CTA options lean slightly casual for the stated tone",
      "Visual anti-patterns section could be more specific to competitive alternatives"
    ],
    refinements: [
      "Consider adding industry-specific messaging variants for different verticals",
      "Develop a micro-copy style guide for UI elements and error states",
      "Create explicit guidance for data visualization styling",
      "Document accessibility requirements for color contrast and motion"
    ]
  };
}
