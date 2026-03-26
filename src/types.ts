export interface BrandBrief {
  company: {
    name: string;
    tagline: string;
    mission: string;
    vision: string;
  };
  icp: {
    role: string;
    painPoints: string[];
    goals: string[];
    psychographics: string[];
  };
  positioning: {
    category: string;
    differentiation: string;
    competitors: string[];
    uniqueValue: string;
  };
  personality: {
    traits: string[];
    tone: string[];
    antiPatterns: string[];
  };
  visual: {
    aesthetic: string[];
    colors: {
      primary: string;
      secondary: string;
      accent: string;
    };
    typography: string;
  };
}

export interface VisualIdentity {
  brandTraits: string[];
  fontDirection: {
    primary: string;
    secondary: string;
    rationale: string;
  };
  colorPalette: {
    name: string;
    hex: string;
    usage: string;
  }[];
  uiShapes: {
    borderRadius: string;
    style: string;
    rationale: string;
  };
  layoutPrinciples: string[];
  imageryDirection: string[];
  motionDirection: string[];
  antiPatterns: string[];
  designRationale: string;
}

export interface HomepageDirection {
  heroHeadline: string;
  heroSubheadline: string;
  ctaOptions: {
    primary: string;
    secondary: string;
  };
  sectionArchitecture: {
    name: string;
    purpose: string;
    order: number;
  }[];
  visualStyle: string[];
  contentBlocks: {
    socialProof: string[];
    productProof: string[];
    featureFraming: string[];
  };
}

export interface VoiceStudio {
  voiceAttributes: string[];
  writingRules: string[];
  wordsToUse: string[];
  wordsToAvoid: string[];
  sampleHeadlines: string[];
  sampleProductCopy: string[];
  sampleCTAs: string[];
  beforeAfter: {
    before: string;
    after: string;
    explanation: string;
  };
}

export interface AlignmentScore {
  icpFit: number;
  positioningClarity: number;
  visualCoherence: number;
  voiceConsistency: number;
  differentiation: number;
}

export interface AlignmentReport {
  scores: AlignmentScore;
  matches: string[];
  drifts: string[];
  refinements: string[];
}

export interface GeneratedSystem {
  visualIdentity: VisualIdentity | null;
  homepageDirection: HomepageDirection | null;
  voiceStudio: VoiceStudio | null;
  alignmentReport: AlignmentReport | null;
}

export type TabId = 'brief' | 'visual' | 'homepage' | 'voice' | 'alignment';
