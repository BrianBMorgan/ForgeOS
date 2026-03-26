import { BrandBrief } from './types';

export const sampleBrief: BrandBrief = {
  company: {
    name: "Forge Intelligence",
    tagline: "Marketing intelligence for modern marketers",
    mission: "Help marketing teams unify fragmented signals, sharpen decisions, and turn execution into measurable growth.",
    vision: "Become the operating system for data-driven marketing teams who refuse to fly blind."
  },
  icp: {
    role: "VP of Marketing or Head of Growth at a B2B SaaS company (Series A to Series C)",
    painPoints: [
      "Data scattered across 15+ tools with no unified view",
      "Spending more time in spreadsheets than on strategy",
      "Can't prove marketing's impact on pipeline",
      "Team drowning in dashboards but starving for insights"
    ],
    goals: [
      "Unified marketing intelligence in one place",
      "Real-time visibility into what's working",
      "Confident resource allocation decisions",
      "Clear attribution that the CFO trusts"
    ],
    psychographics: [
      "Values precision over guesswork",
      "Respects tools that respect their time",
      "Skeptical of hype, responds to substance",
      "Wants to be seen as strategic, not tactical"
    ]
  },
  positioning: {
    category: "Marketing Intelligence Platform",
    differentiation: "Unlike point solutions that add more noise, Forge Intelligence synthesizes signals across the entire marketing ecosystem into actionable clarity.",
    competitors: [
      "HubSpot (too broad, not intelligence-focused)",
      "Tableau (too technical, not marketing-native)",
      "Domo (expensive, slow to value)"
    ],
    uniqueValue: "The only platform that combines data unification, AI-powered insights, and strategic recommendations in a single interface designed for marketing leaders."
  },
  personality: {
    traits: [
      "Intelligent",
      "Precise",
      "Calm",
      "Strategic",
      "Premium"
    ],
    tone: [
      "Confident but not arrogant",
      "Clear but not simplistic",
      "Warm but not casual",
      "Expert but not academic"
    ],
    antiPatterns: [
      "Jargon-heavy enterprise speak",
      "Playful or whimsical language",
      "Aggressive sales pressure",
      "Vague or buzzword-filled claims"
    ]
  },
  visual: {
    aesthetic: [
      "Clean",
      "Structured",
      "Modern",
      "Premium",
      "Trustworthy"
    ],
    colors: {
      primary: "#0F172A",
      secondary: "#3B82F6",
      accent: "#10B981"
    },
    typography: "Modern sans-serif with strong hierarchy"
  }
};

export const sampleBriefJSON = JSON.stringify(sampleBrief, null, 2);
