// To run this code you need to install the following dependencies:
// npm install @google/generative-ai dotenv mime
// npm install -D @types/node typescript

import * as dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { FootballAnalysis } from './types';
import { generatePDFReports } from './pdfGenerator';

dotenv.config();

function saveJsonFile(fileName: string, data: any) {
  try {
    const jsonString = JSON.stringify(data, null, 2);
    writeFileSync(fileName, jsonString, 'utf8');
    console.log(`\nFile ${fileName} saved to file system.`);
  } catch (err) {
    console.error(`Error writing file ${fileName}:`, err);
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY not found in environment variables');
    return;
  }

  const videoUri = 'https://www.youtube.com/watch?v=OgMZTA19TEI';

  console.log('Running multi-pass video analysis...');
  try {
    const { runMultiPass } = await import('./multiPassAnalyzer');

    // You can change the model here: 'gemini-2.5-pro' or 'gemini-2.5-flash'
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    
    const { analysis } = await runMultiPass(videoUri, apiKey, {
      prefer: ['pass3', 'pass2', 'pass1'],
      thresholds: { accept: 0.55, override: 0.7 }
    }, modelName);

    console.log(`Parsed ${analysis.plays.length} plays after aggregation.`);
    analysis.plays.forEach((play, i) => {
      console.log(`- [${i + 1}] ${play.play_id} ${play.video_timestamps.start_time}–${play.video_timestamps.end_time} | ${play.play.play_type} | ${play.result.outcome}`);
    });

    // Save final analysis JSON
    saveJsonFile('football_analysis.json', analysis as FootballAnalysis);

    // Generate PDF reports (detailed and summary)
    try {
      const { detailedPath, summaryPath } = await generatePDFReports(analysis, {
        outputPathDetailed: 'football_analysis.pdf',
        outputPathSummary: 'football_analysis_summary.pdf',
        reportTitle: 'Football Game Analysis Report'
      });
      console.log(`PDF reports generated:
- Detailed: ${detailedPath}
- Summary: ${summaryPath}`);
    } catch (pdfErr) {
      console.error('Failed to generate PDF reports:', pdfErr);
    }
  } catch (err) {
    console.error('Multi-pass analysis failed:', err);
  }
}

main().catch(console.error);