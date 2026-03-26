import { useState, useCallback } from 'react';
import { BrandBrief, TabId, GeneratedSystem } from './types';
import { sampleBriefJSON } from './sampleBrief';
import { 
  generateVisualIdentity, 
  generateHomepageDirection, 
  generateVoiceStudio, 
  generateAlignmentReport 
} from './generator';
import { Sidebar } from './components/Sidebar';
import { BrandBriefTab } from './components/BrandBriefTab';
import { VisualIdentityTab } from './components/VisualIdentityTab';
import { HomepageDirectionTab } from './components/HomepageDirectionTab';
import { VoiceStudioTab } from './components/VoiceStudioTab';
import { AlignmentReportTab } from './components/AlignmentReportTab';

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('brief');
  const [briefJson, setBriefJson] = useState<string>(sampleBriefJSON);
  const [parsedBrief, setParsedBrief] = useState<BrandBrief | null>(null);
  const [generatedSystem, setGeneratedSystem] = useState<GeneratedSystem>({
    visualIdentity: null,
    homepageDirection: null,
    voiceStudio: null,
    alignmentReport: null,
  });

  const hasGeneratedSystem = generatedSystem.visualIdentity !== null;

  const handleBriefChange = useCallback((json: string) => {
    setBriefJson(json);
    try {
      const parsed = JSON.parse(json);
      setParsedBrief(parsed);
    } catch {
      setParsedBrief(null);
    }
  }, []);

  const handleGenerate = useCallback(() => {
    try {
      const brief = JSON.parse(briefJson) as BrandBrief;
      setParsedBrief(brief);
      
      // Generate all outputs from the brief
      const system: GeneratedSystem = {
        visualIdentity: generateVisualIdentity(brief),
        homepageDirection: generateHomepageDirection(brief),
        voiceStudio: generateVoiceStudio(brief),
        alignmentReport: generateAlignmentReport(brief),
      };
      
      setGeneratedSystem(system);
      setActiveTab('visual'); // Navigate to first output tab
    } catch (e) {
      console.error('Failed to generate system:', e);
    }
  }, [briefJson]);

  // Parse initial sample brief
  useState(() => {
    try {
      setParsedBrief(JSON.parse(sampleBriefJSON));
    } catch {
      // Ignore
    }
  });

  const renderTab = () => {
    switch (activeTab) {
      case 'brief':
        return (
          <BrandBriefTab
            briefJson={briefJson}
            onBriefChange={handleBriefChange}
            onGenerate={handleGenerate}
            parsedBrief={parsedBrief}
          />
        );
      case 'visual':
        return <VisualIdentityTab data={generatedSystem.visualIdentity} />;
      case 'homepage':
        return <HomepageDirectionTab data={generatedSystem.homepageDirection} />;
      case 'voice':
        return <VoiceStudioTab data={generatedSystem.voiceStudio} />;
      case 'alignment':
        return <AlignmentReportTab data={generatedSystem.alignmentReport} />;
      default:
        return null;
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasGeneratedSystem={hasGeneratedSystem}
      />
      <main className="main-content">
        {renderTab()}
      </main>
    </div>
  );
}

export default App;
