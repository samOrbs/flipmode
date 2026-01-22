import { App, Editor, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, requestUrl, ItemView } from 'obsidian';
import { FLIPMODE_HEADER_BASE64 } from './header-asset';

// Plugin settings interface
interface BJJFlipmodeSettings {
    serverUrl: string;
    apiToken: string;
    syncFolder: string;
    autoSync: boolean;
    syncInterval: number;
    userId: string;
    // Mode settings
    mode: 'local' | 'remote' | 'coach';
    queueServiceUrl: string;
    athleteToken: string;
    pollInterval: number;
    // Coach mode settings
    coachToken: string;
    // Season/Episode tracking
    currentSeason: number;
    currentEpisode: number;
    // Athlete identity (for coach to know whose notes these are)
    athleteName: string;
    // Concepts folder structure
    conceptsSubfolder: string;
}

const DEFAULT_SETTINGS: BJJFlipmodeSettings = {
    serverUrl: 'http://localhost:5005',
    apiToken: '',
    syncFolder: 'Flipmode',
    autoSync: false,
    syncInterval: 30,
    userId: 'default',
    // Mode defaults
    mode: 'local',
    queueServiceUrl: 'https://flipmode-d2c51311485b.herokuapp.com',
    athleteToken: '',
    pollInterval: 10,
    // Coach mode defaults
    coachToken: '',
    // Season/Episode tracking
    currentSeason: 1,
    currentEpisode: 1,
    // Athlete identity
    athleteName: 'Athlete',
    // Concepts folder structure
    conceptsSubfolder: 'concepts'
};

// Pending job for tracking remote queries
interface PendingJob {
    jobId: string;
    query: string;
    submittedAt: Date;
    status: 'pending' | 'processing' | 'complete' | 'error';
}

// Remote Queue Client for athlete mode
class RemoteQueueClient {
    private baseUrl: string;
    private token: string;

    constructor(baseUrl: string, token: string) {
        this.baseUrl = baseUrl;
        this.token = token;
    }

    async submitQuery(query: string, therapyContext?: any): Promise<{ jobId: string }> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/submit`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify({
                query_text: query,
                therapy_context: therapyContext
            })
        });

        return { jobId: response.json.job_id };
    }

    async checkStatus(jobId: string): Promise<{ status: string; progress?: string }> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/status/${jobId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });

        return {
            status: response.json.status,
            progress: response.json.started_at ? 'Processing...' : 'Queued'
        };
    }

    async getResult(jobId: string): Promise<{
        article: string;
        sources: any[];
        rlm_session_id?: string;
        error?: string;
    }> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/result/${jobId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });

        const data = response.json;
        if (data.status === 'error') {
            return { article: '', sources: [], error: data.error };
        }

        return {
            article: data.result_article || '',
            sources: data.result_sources || [],
            rlm_session_id: data.rlm_session_id
        };
    }

    async listJobs(): Promise<any[]> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/jobs`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });

        return response.json.jobs || [];
    }

    async syncGraph(graphData: any): Promise<void> {
        await requestUrl({
            url: `${this.baseUrl}/api/queue/graph/sync`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify(graphData)
        });
    }

    async getConcepts(): Promise<any[]> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/concepts`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });
        return response.json.concepts || [];
    }

    async checkHealth(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/health`,
                method: 'GET'
            });
            return response.json.status === 'healthy';
        } catch {
            return false;
        }
    }
}

// Coach Queue Client for coach mode
class CoachQueueClient {
    private baseUrl: string;
    private token: string;

    constructor(baseUrl: string, token: string) {
        this.baseUrl = baseUrl;
        this.token = token;
    }

    async getAthletes(): Promise<any[]> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/coach/roster`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        return response.json.athletes || [];
    }

    async addAthlete(discordId: string, displayName?: string): Promise<any> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/coach/roster`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ discord_id: discordId, display_name: displayName })
        });
        return response.json;
    }

    async getPendingJobs(): Promise<any[]> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/pending`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        return response.json.jobs || [];
    }

    async getAthleteGraph(athleteId: number): Promise<any> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/graph/${athleteId}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        return response.json;
    }

    async claimJob(jobId: string): Promise<any> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/claim/${jobId}`,
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        return response.json;
    }

    async completeJob(jobId: string, article: string, sources: any[]): Promise<boolean> {
        try {
            await requestUrl({
                url: `${this.baseUrl}/api/queue/complete/${jobId}`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    result_article: article,
                    result_sources: sources,
                    rlm_session_id: `coach_${jobId}`
                })
            });
            return true;
        } catch {
            return false;
        }
    }

    async getStats(): Promise<any> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/coach/stats`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.token}` }
        });
        return response.json;
    }

    async checkHealth(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/health`,
                method: 'GET'
            });
            return response.json.status === 'healthy';
        } catch {
            return false;
        }
    }

    async pushConcepts(athleteId: number, concepts: any[]): Promise<{ created: number; updated: number }> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/queue/concepts/push`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                athlete_id: athleteId,
                concepts: concepts
            })
        });
        return response.json;
    }

    async shareConceptGraph(athleteId: number, conceptName: string, conceptSummary: string, graphData: any): Promise<{ success: boolean; message: string }> {
        const response = await requestUrl({
            url: `${this.baseUrl}/api/coach/share-concept-graph`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                athlete_id: athleteId,
                concept_name: conceptName,
                concept_summary: conceptSummary,
                graph_data: graphData
            })
        });
        return response.json;
    }
}

export default class BJJFlipmodePlugin extends Plugin {
    settings: BJJFlipmodeSettings;
    statusBarItem: HTMLElement;
    syncIntervalId: number | null = null;
    // Remote mode (athlete)
    pendingJobs: Map<string, PendingJob> = new Map();
    pollIntervalId: number | null = null;
    queueClient: RemoteQueueClient | null = null;
    // Coach mode
    coachClient: CoachQueueClient | null = null;

    async onload() {
        await this.loadSettings();

        // Add status bar item
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('Disconnected');

        // Add ribbon icon
        this.addRibbonIcon('brain-circuit', 'Flipmode', async () => {
            await this.showFlipmodeMenu();
        });

        // Register custom URI handler for sync-and-open from Discord links
        this.registerObsidianProtocolHandler('flipmode-sync', async (params) => {
            const conceptName = params.concept;
            if (conceptName) {
                await this.syncAndOpenConcept(conceptName);
            }
        });

        // Add commands
        this.addCommand({
            id: 'flipmode-voice-note',
            name: 'Record training voice note',
            callback: () => this.showVoiceNoteModal()
        });

        this.addCommand({
            id: 'flipmode-research',
            name: 'Research a technique',
            callback: () => this.showResearchModal()
        });

        this.addCommand({
            id: 'flipmode-sync',
            name: 'Sync with Flipmode',
            callback: () => this.syncWithFlipmode()
        });

        this.addCommand({
            id: 'flipmode-quick-note',
            name: 'Quick training note',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.insertTrainingTemplate(editor);
            }
        });

        this.addCommand({
            id: 'flipmode-check-connection',
            name: 'Check Flipmode connection',
            callback: () => this.checkConnection()
        });

        this.addCommand({
            id: 'flipmode-view-pending-jobs',
            name: 'View pending coach queries',
            callback: () => this.showPendingJobsModal()
        });

        this.addCommand({
            id: 'flipmode-connect-discord',
            name: 'Connect with Discord (remote mode)',
            callback: () => this.connectWithDiscord()
        });

        // Coach mode commands
        this.addCommand({
            id: 'flipmode-coach-sync',
            name: 'Coach: Sync all athletes',
            callback: () => this.coachSyncAthletes()
        });

        this.addCommand({
            id: 'flipmode-coach-pending',
            name: 'Coach: View pending queries',
            callback: () => this.coachShowPending()
        });

        this.addCommand({
            id: 'flipmode-coach-generate',
            name: 'Coach: Generate article for current query',
            editorCallback: (editor: Editor, view: MarkdownView) => this.coachGenerateArticle(view)
        });

        this.addCommand({
            id: 'flipmode-coach-push',
            name: 'Coach: Push article to athlete',
            editorCallback: (editor: Editor, view: MarkdownView) => this.coachPushArticle(view)
        });

        this.addCommand({
            id: 'flipmode-coach-push-concepts',
            name: 'Coach: Push concepts to athlete',
            callback: () => this.coachPushConcepts()
        });

        this.addCommand({
            id: 'flipmode-coach-add-athlete',
            name: 'Coach: Add athlete to roster',
            callback: () => this.coachAddAthlete()
        });

        this.addCommand({
            id: 'flipmode-dive-deeper-session',
            name: 'Dive Deeper on this session',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await this.diveDeepOnSession(view);
            }
        });

        this.addCommand({
            id: 'flipmode-generate-training-review',
            name: 'Generate Training Review (from Training Notes)',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await this.generateTrainingReview(view);
            }
        });

        this.addCommand({
            id: 'flipmode-publish-training-review',
            name: 'Publish Training Review (send to athlete)',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await this.publishTrainingReview(view);
            }
        });

        this.addCommand({
            id: 'flipmode-open-audio-player',
            name: 'Open Audio Player',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await this.openAudioPlayer(view);
            }
        });

        // Athlete: Sync completed research from coach
        this.addCommand({
            id: 'flipmode-sync-from-coach',
            name: 'Sync from Oracle (fetch completed research)',
            callback: async () => {
                await this.syncFromCoach();
            }
        });

        // Find Video for Canvas Node - works when Canvas is active
        this.addCommand({
            id: 'flipmode-find-video-canvas',
            name: 'Find Video for Selected Concept (Canvas)',
            checkCallback: (checking: boolean) => {
                const canvasView = this.app.workspace.getActiveViewOfType(ItemView);
                if (canvasView && canvasView.getViewType() === 'canvas') {
                    if (!checking) {
                        this.findVideoForCanvasNode(canvasView);
                    }
                    return true;
                }
                return false;
            }
        });

        // RLM Enrich & Rebuild - single button for full pipeline
        this.addCommand({
            id: 'flipmode-rlm-pipeline',
            name: 'RLM: Enrich & Rebuild Canvas',
            checkCallback: (checking: boolean) => {
                const canvasView = this.app.workspace.getActiveViewOfType(ItemView);
                if (canvasView && canvasView.getViewType() === 'canvas') {
                    if (!checking) {
                        this.runRLMPipeline(canvasView);
                    }
                    return true;
                }
                return false;
            }
        });

        // Add settings tab
        this.addSettingTab(new BJJFlipmodeSettingTab(this.app, this));

        // Register right-click context menu for Coach Review, Training Plan, and Dive Deeper
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
                const selection = editor.getSelection();
                if (selection && selection.trim().length > 0) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Generate Training Review')
                            .setIcon('graduation-cap')
                            .onClick(async () => {
                                await this.generateTrainingReviewFromSelection(editor, view, selection);
                            });
                    });
                    menu.addItem((item) => {
                        item
                            .setTitle('Generate Skill Development')
                            .setIcon('dumbbell')
                            .onClick(async () => {
                                await this.generateTrainingPlanFromSelection(editor, view, selection);
                            });
                    });
                    // Dive Deeper - only show on files with rlm_session_id
                    menu.addItem((item) => {
                        item
                            .setTitle('Dive Deeper')
                            .setIcon('search')
                            .onClick(async () => {
                                await this.diveDeeper(editor, view, selection);
                            });
                    });
                    // Explode to Concept Graph
                    menu.addItem((item) => {
                        item
                            .setTitle('Explode to Concept Graph')
                            .setIcon('git-branch')
                            .onClick(async () => {
                                await this.explodeToConceptGraph(editor, view, selection);
                            });
                    });
                }
            })
        );

        // Right-click menu on Canvas nodes
        this.registerEvent(
            this.app.workspace.on('canvas:node-menu', (menu: Menu, node: any) => {
                // Check if this node has linked sources (from Oracle article)
                let hasLinkedSources = false;
                let sessionId: string | null = null;

                if (node.file) {
                    const cache = this.app.metadataCache.getFileCache(node.file);
                    if (cache?.frontmatter?.source_rlm_session) {
                        hasLinkedSources = true;
                        sessionId = cache.frontmatter.source_rlm_session;
                    }
                }

                if (hasLinkedSources && sessionId) {
                    // Show bibliography from parent Oracle article
                    menu.addItem((item) => {
                        item
                            .setTitle('View Source Videos')
                            .setIcon('library')
                            .onClick(async () => {
                                await this.showArticleBibliography(node, sessionId!);
                            });
                    });
                }

                // Always show semantic search as fallback
                menu.addItem((item) => {
                    item
                        .setTitle('Search Videos (Semantic)')
                        .setIcon('search')
                        .onClick(async () => {
                            await this.findVideoForCanvasNodeDirect(node);
                        });
                });

                menu.addItem((item) => {
                    item
                        .setTitle('Explore Full Series')
                        .setIcon('layers')
                        .onClick(async () => {
                            await this.exploreSeriesForCanvasNode(node);
                        });
                });

                // Cross-reference with catalog
                menu.addItem((item) => {
                    item
                        .setTitle('Cross-Reference with Catalog')
                        .setIcon('git-compare')
                        .onClick(async () => {
                            await this.openCrossReferenceCatalog(node);
                        });
                });

                // RLM Enrichment - only for checkpoint files
                if (node.file) {
                    const cache = this.app.metadataCache.getFileCache(node.file);
                    if (cache?.frontmatter?.type === 'checkpoint') {
                        menu.addItem((item) => {
                            item
                                .setTitle('Enrich Checkpoint (RLM)')
                                .setIcon('sparkles')
                                .onClick(async () => {
                                    await this.openEnrichCheckpoint(node);
                                });
                        });
                    }

                    // Extract Clip - for method nodes with timestamp
                    if (cache?.frontmatter?.type === 'method' && cache.frontmatter.timestamp) {
                        menu.addItem((item) => {
                            item
                                .setTitle('Extract WebM Clip')
                                .setIcon('video')
                                .onClick(async () => {
                                    await this.extractClipFromMethod(node.file, cache.frontmatter);
                                });
                        });
                    }
                }
            })
        );

        // Right-click menu on files in file explorer
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TFile) => {
                if (!(file instanceof TFile)) return;

                // Canvas files - share with athlete
                if (file.extension === 'canvas') {
                    if (this.settings.mode === 'coach' && this.coachClient) {
                        menu.addItem((item) => {
                            item
                                .setTitle('Share Canvas with Athlete')
                                .setIcon('send')
                                .onClick(async () => {
                                    await this.shareCanvasWithAthlete(file);
                                });
                        });
                    }
                    return;
                }

                // Only show rest for markdown files
                if (file.extension !== 'md') return;

                // Check if we're in a Canvas view - if so, skip these (canvas:node-menu handles it)
                const activeView = this.app.workspace.getActiveViewOfType(ItemView);
                const isCanvasView = activeView && activeView.getViewType() === 'canvas';

                if (isCanvasView) {
                    // Canvas has its own menu - don't duplicate
                    return;
                }

                // File explorer right-click menu (not Canvas)
                menu.addItem((item) => {
                    item
                        .setTitle('Get Training Drills')
                        .setIcon('dumbbell')
                        .onClick(async () => {
                            await this.getTrainingDrillsForConcept(file);
                        });
                });

                menu.addItem((item) => {
                    item
                        .setTitle('Research This Concept')
                        .setIcon('search')
                        .onClick(async () => {
                            await this.researchConcept(file);
                        });
                });

                // Coach mode only
                if (this.settings.mode === 'coach' && this.coachClient) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Share with Athlete via Discord')
                            .setIcon('send')
                            .onClick(async () => {
                                await this.shareConceptGraphWithAthlete(file);
                            });
                    });
                }
            })
        );

        // Check connection on startup
        this.checkConnection();

        // Start auto-sync if enabled
        if (this.settings.autoSync) {
            this.startAutoSync();
        }

        // Initialize remote mode if configured
        if (this.settings.mode === 'remote' && this.settings.queueServiceUrl && this.settings.athleteToken) {
            this.initRemoteMode();
        }

        // Initialize coach mode if configured
        if (this.settings.mode === 'coach' && this.settings.queueServiceUrl && this.settings.coachToken) {
            this.initCoachMode();
        }
    }

    // Coach mode methods
    initCoachMode() {
        this.coachClient = new CoachQueueClient(
            this.settings.queueServiceUrl,
            this.settings.coachToken
        );
        this.updateStatusBar('Coach Mode');
    }

    isCoachMode(): boolean {
        return this.settings.mode === 'coach' && !!this.coachClient;
    }

    async coachSyncAthletes() {
        if (!this.coachClient) {
            new Notice('Coach mode not configured');
            return;
        }

        new Notice('Syncing athletes...');

        try {
            const athletes = await this.coachClient.getAthletes();
            const athletesFolder = `${this.settings.syncFolder}/Athletes`;

            // Ensure folder exists
            await this.ensureFolder(athletesFolder);

            for (const athlete of athletes) {
                const name = athlete.display_name || athlete.discord_username || `Athlete_${athlete.id}`;
                const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
                const athleteFolder = `${athletesFolder}/${safeName}`;

                await this.ensureFolder(athleteFolder);

                // Get graph data
                const graphData = await this.coachClient.getAthleteGraph(athlete.id);
                const graph = graphData?.graph_data || { sessions: [], queries: [], topics: [] };

                // Create summary note
                const summaryContent = this.createAthleteSummary(name, athlete, graph);
                await this.saveNote(`${athleteFolder}/summary.md`, summaryContent);
            }

            // Sync pending queries
            const pending = await this.coachClient.getPendingJobs();
            const inboxFolder = `${this.settings.syncFolder}/Inbox`;
            await this.ensureFolder(inboxFolder);

            for (const job of pending) {
                const filename = `${inboxFolder}/${job.job_id.substring(0, 8)} - ${job.athlete_name || 'Unknown'}.md`;

                // Don't overwrite existing
                if (await this.app.vault.adapter.exists(filename)) continue;

                const content = this.createPendingQueryNote(job);
                await this.saveNote(filename, content);
            }

            new Notice(`Synced ${athletes.length} athletes, ${pending.length} pending queries`);
        } catch (error) {
            console.error('Sync error:', error);
            new Notice('Sync failed - check connection');
        }
    }

    createAthleteSummary(name: string, athlete: any, graph: any): string {
        const sessions = graph.sessions || [];
        const queries = graph.queries || [];
        const topics = graph.topics || [];

        let content = `---
type: athlete-summary
athlete_id: ${athlete.id}
discord_id: ${athlete.discord_id}
updated: ${new Date().toISOString().split('T')[0]}
---

# ${name}

## Overview

- **Sessions:** ${sessions.length}
- **Queries:** ${queries.length}
- **Topics:** ${topics.length}

## Topics Explored

${topics.length > 0 ? topics.map((t: string) => `- ${t}`).join('\n') : '*No topics yet*'}

## Recent Queries

`;
        const sortedQueries = [...queries].sort((a: any, b: any) =>
            (b.date || '').localeCompare(a.date || '')
        ).slice(0, 10);

        for (const q of sortedQueries) {
            const status = q.pending ? '⏳' : '✓';
            content += `- [${status}] ${q.topic || 'Unknown'} (${q.date || 'N/A'})\n`;
        }

        content += `\n## Recent Sessions\n\n`;

        const sortedSessions = [...sessions].sort((a: any, b: any) =>
            (b.date || '').localeCompare(a.date || '')
        ).slice(0, 10);

        for (const s of sortedSessions) {
            const tags = (s.tags || []).join(', ');
            content += `- ${s.date || 'Unknown'} - ${tags || 'No tags'}\n`;
        }

        return content;
    }

    createPendingQueryNote(job: any): string {
        return `---
type: pending-query
job_id: ${job.job_id}
athlete_id: ${job.athlete_id}
athlete_name: ${job.athlete_name || 'Unknown'}
submitted: ${job.submitted_at}
status: pending
---

# Query from ${job.athlete_name || 'Unknown'}

**Submitted:** ${job.submitted_at}

## Question

${job.query_text}

---

## Actions

1. Run command: **Coach: Generate article for current query**
2. Edit the generated article below
3. Run command: **Coach: Push article to athlete**

---

## Generated Article

*Run "Coach: Generate article" to populate this section*

`;
    }

    async shareConceptGraphWithAthlete(file: TFile) {
        if (!this.coachClient) {
            new Notice('Coach mode not configured');
            return;
        }

        // Read file content to determine if it's a concept/cluster file
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
            new Notice('No frontmatter found');
            return;
        }

        const fm = frontmatterMatch[1];
        const isCluster = fm.includes('type: cluster-index');
        const isConcept = fm.includes('type: concept');

        if (!isCluster && !isConcept) {
            new Notice('This file is not a concept or cluster file');
            return;
        }

        // Get athletes list for selection
        try {
            const athletes = await this.coachClient.getAthletes();

            if (athletes.length === 0) {
                new Notice('No athletes found. Add athletes first.');
                return;
            }

            // Create selection modal
            const modal = new AthleteSelectModal(this.app, athletes, async (selectedAthlete) => {
                if (!selectedAthlete) return;

                // Collect concept graph data
                let graphData: any = {};
                let conceptName = file.basename;
                let conceptSummary = '';

                if (isCluster) {
                    // Get all concepts in this cluster folder
                    const clusterFolder = file.parent?.path || '';
                    const conceptFiles = this.app.vault.getMarkdownFiles().filter(f =>
                        f.path.startsWith(clusterFolder) && f.path !== file.path
                    );

                    const concepts = [];
                    for (const cf of conceptFiles) {
                        const cfContent = await this.app.vault.read(cf);
                        concepts.push({
                            name: cf.basename,
                            content: cfContent
                        });
                    }

                    graphData = {
                        type: 'cluster',
                        clusterName: conceptName,
                        concepts: concepts,
                        indexContent: content
                    };

                    // Extract summary from cluster index
                    const summaryMatch = content.match(/## Summary\n\n([\s\S]*?)(?=\n## |$)/);
                    conceptSummary = summaryMatch ? summaryMatch[1].trim().substring(0, 200) : '';
                } else {
                    // Single concept
                    graphData = {
                        type: 'concept',
                        conceptName: conceptName,
                        content: content
                    };

                    const summaryMatch = content.match(/## Summary\n\n([\s\S]*?)(?=\n## |$)/);
                    conceptSummary = summaryMatch ? summaryMatch[1].trim().substring(0, 200) : '';
                }

                // Send to queue service
                new Notice(`Sharing "${conceptName}" with ${selectedAthlete.display_name || selectedAthlete.discord_username}...`);

                try {
                    const result = await this.coachClient!.shareConceptGraph(
                        selectedAthlete.id,
                        conceptName,
                        conceptSummary,
                        graphData
                    );

                    if (result.success) {
                        new Notice(`Shared with ${selectedAthlete.display_name || selectedAthlete.discord_username}`);
                    } else {
                        new Notice(`Saved but Discord notification failed: ${result.message}`);
                    }
                } catch (error: any) {
                    new Notice(`Failed to share: ${error.message}`);
                }
            });

            modal.open();

        } catch (error: any) {
            new Notice(`Failed to get athletes: ${error.message}`);
        }
    }

    async shareCanvasWithAthlete(file: TFile) {
        if (!this.coachClient) {
            new Notice('Coach mode not configured');
            return;
        }

        // Read canvas content
        const content = await this.app.vault.read(file);
        let canvasData: any;
        try {
            canvasData = JSON.parse(content);
        } catch (e) {
            new Notice('Invalid canvas file');
            return;
        }

        const canvasName = file.basename;

        // Get athletes list
        try {
            const athletes = await this.coachClient.getAthletes();

            if (athletes.length === 0) {
                new Notice('No athletes found. Add athletes first.');
                return;
            }

            // Create selection modal
            const modal = new AthleteSelectModal(this.app, athletes, async (selectedAthlete) => {
                if (!selectedAthlete) return;

                new Notice(`Sharing canvas "${canvasName}" with ${selectedAthlete.display_name || selectedAthlete.discord_username}...`);

                try {
                    const result = await this.coachClient!.shareConceptGraph(
                        selectedAthlete.id,
                        canvasName + ' (Timeline)',
                        'Visual timeline canvas for training sequence',
                        {
                            type: 'canvas',
                            canvasName: canvasName,
                            nodes: canvasData.nodes || [],
                            edges: canvasData.edges || []
                        }
                    );

                    if (result.success) {
                        new Notice(`Shared with ${selectedAthlete.display_name || selectedAthlete.discord_username}!`);
                    } else {
                        new Notice(`Saved but Discord notification failed: ${result.message}`);
                    }
                } catch (error: any) {
                    new Notice(`Failed to share: ${error.message}`);
                }
            });

            modal.open();

        } catch (error: any) {
            new Notice(`Failed to get athletes: ${error.message}`);
        }
    }

    /**
     * Extract WebM video clips from a Training Review article and create a Canvas with embedded clips.
     * Non-destructive: original videos are never modified, clips are created as new files.
     */
    async extractVideoClipsToCanvas(file: TFile) {
        // Read file content
        const content = await this.app.vault.read(file);

        // Check if this is a training review
        if (!content.includes('type: training-review')) {
            new Notice('This command works on Training Review files');
            return;
        }

        // Extract article HTML (the content after frontmatter)
        const frontmatterEnd = content.indexOf('---', 4);
        if (frontmatterEnd === -1) {
            new Notice('No frontmatter found');
            return;
        }
        const articleContent = content.substring(frontmatterEnd + 3);

        new Notice('Extracting video clips... This may take a moment.', 5000);

        try {
            // Call the WebM extraction API
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/extract-clips-webm-from-article`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    article_html: articleContent,
                    duration: 60  // 1 minute clips
                })
            });

            const data = response.json;
            const clips = data.clips || [];

            if (clips.length === 0) {
                new Notice('No video clips found in article');
                return;
            }

            new Notice(`Found ${clips.length} clips. Downloading...`, 5000);

            // Create clips folder in vault
            const reviewName = file.basename;
            const clipsFolder = `${file.parent?.path || this.settings.syncFolder}/clips/${reviewName}`;
            await this.ensureFolder(clipsFolder);

            // Download each clip and save to vault
            const savedClips: { path: string; clip: any }[] = [];
            for (let i = 0; i < clips.length; i++) {
                const clip = clips[i];
                const clipFilename = `${clip.video_id}_${clip.start_time}s.webm`;
                const clipPath = `${clipsFolder}/${clipFilename}`;

                try {
                    // Download clip binary
                    const clipResponse = await requestUrl({
                        url: `${this.settings.serverUrl}${clip.clip_url}`,
                        method: 'GET'
                    });

                    // Save to vault as binary
                    await this.app.vault.adapter.writeBinary(clipPath, clipResponse.arrayBuffer);
                    savedClips.push({ path: clipPath, clip });

                    new Notice(`Downloaded clip ${i + 1}/${clips.length}`, 2000);
                } catch (clipErr) {
                    console.error(`Failed to download clip ${clip.clip_id}:`, clipErr);
                }
            }

            if (savedClips.length === 0) {
                new Notice('Failed to download any clips');
                return;
            }

            // Create Canvas with video clips
            const canvasPath = `${file.parent?.path || this.settings.syncFolder}/${reviewName} - Video Clips.canvas`;

            const nodes: any[] = [];
            const edges: any[] = [];
            let nodeId = 1;

            // Layout: horizontal grid of video clips
            const clipWidth = 400;
            const clipHeight = 300;
            const spacing = 50;
            const cols = 3;

            for (let i = 0; i < savedClips.length; i++) {
                const { path, clip } = savedClips[i];
                const row = Math.floor(i / cols);
                const col = i % cols;

                // Video node (link to local file)
                nodes.push({
                    id: `video-${nodeId++}`,
                    type: 'file',
                    file: path,
                    x: col * (clipWidth + spacing),
                    y: row * (clipHeight + spacing + 80),
                    width: clipWidth,
                    height: clipHeight,
                    color: '5'  // Cyan for videos
                });

                // Label node below video
                nodes.push({
                    id: `label-${nodeId++}`,
                    type: 'text',
                    text: `**${clip.instructor}**\n${clip.title}\n_at ${clip.timestamp}_`,
                    x: col * (clipWidth + spacing),
                    y: row * (clipHeight + spacing + 80) + clipHeight + 10,
                    width: clipWidth,
                    height: 70,
                    color: '0'
                });
            }

            // Add title node
            nodes.unshift({
                id: 'title',
                type: 'text',
                text: `# Video Clips: ${reviewName}\n\n${savedClips.length} clips extracted from training review`,
                x: 0,
                y: -120,
                width: cols * (clipWidth + spacing) - spacing,
                height: 100,
                color: '6'  // Purple for title
            });

            const canvasContent = JSON.stringify({ nodes, edges }, null, 2);

            // Save canvas
            const existingCanvas = this.app.vault.getAbstractFileByPath(canvasPath);
            if (existingCanvas instanceof TFile) {
                await this.app.vault.modify(existingCanvas, canvasContent);
            } else {
                await this.app.vault.create(canvasPath, canvasContent);
            }

            new Notice(`Created video canvas with ${savedClips.length} clips!`, 5000);

            // Open the canvas
            const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
            if (canvasFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(canvasFile);
            }

        } catch (error: any) {
            console.error('Video clip extraction error:', error);
            new Notice(`Failed to extract clips: ${error.message}`, 5000);
        }
    }

    /**
     * Search videos for checkpoint/concept demonstrations.
     * Uses semantic search to find videos that demonstrate a specific technique.
     */
    async searchVideosForConcept(conceptName: string, context?: string): Promise<any[]> {
        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/search-videos-for-concept`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    concept: conceptName,
                    context: context || '',
                    max_results: 5
                })
            });

            return response.json.videos || [];
        } catch (error) {
            console.error('Video search error:', error);
            return [];
        }
    }

    /**
     * Find videos demonstrating a concept and create a canvas with clips.
     * Uses semantic search (separate from Oracle) to find matching videos.
     */
    async findVideosForConcept(file: TFile) {
        // Read file to get concept name and context
        const content = await this.app.vault.read(file);

        // Extract frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatterMatch) {
            new Notice('No frontmatter found');
            return;
        }

        const frontmatter = frontmatterMatch[1];

        // Get concept name (file basename or from frontmatter)
        const conceptName = file.basename;

        // Try to extract context from parent checkpoint or summary
        const summaryMatch = content.match(/## Summary\n\n([^\n#]+)/);
        const context = summaryMatch ? summaryMatch[1].trim() : '';

        new Notice(`Searching for videos demonstrating "${conceptName}"...`, 5000);

        try {
            // Search for videos
            const videos = await this.searchVideosForConcept(conceptName, context);

            if (videos.length === 0) {
                new Notice(`No videos found for "${conceptName}"`, 3000);
                return;
            }

            new Notice(`Found ${videos.length} videos! Creating canvas...`, 3000);

            // Create clips folder
            const clipsFolder = `${file.parent?.path || this.settings.syncFolder}/clips/${conceptName}`;
            await this.ensureFolder(clipsFolder);

            // Download clips
            const savedClips: { path: string; video: any }[] = [];
            for (let i = 0; i < videos.length; i++) {
                const video = videos[i];
                if (!video.clip_url) continue;

                const clipFilename = `${video.video_id}_${video.timestamp_seconds || 0}s.webm`;
                const clipPath = `${clipsFolder}/${clipFilename}`;

                try {
                    const clipResponse = await requestUrl({
                        url: `${this.settings.serverUrl}${video.clip_url}`,
                        method: 'GET'
                    });

                    await this.app.vault.adapter.writeBinary(clipPath, clipResponse.arrayBuffer);
                    savedClips.push({ path: clipPath, video });
                    new Notice(`Downloaded clip ${i + 1}/${videos.length}`, 2000);
                } catch (err) {
                    console.error(`Failed to download clip:`, err);
                }
            }

            if (savedClips.length === 0) {
                new Notice('Failed to download any clips');
                return;
            }

            // Create canvas with clips
            const canvasPath = `${file.parent?.path || this.settings.syncFolder}/${conceptName} - Videos.canvas`;

            const nodes: any[] = [];
            let nodeId = 1;

            const clipWidth = 400;
            const clipHeight = 300;
            const spacing = 50;
            const cols = 2;

            // Title node
            nodes.push({
                id: 'title',
                type: 'text',
                text: `# Videos: ${conceptName}\n\n${savedClips.length} videos demonstrating this technique`,
                x: 0,
                y: -120,
                width: cols * (clipWidth + spacing) - spacing,
                height: 100,
                color: '6'
            });

            for (let i = 0; i < savedClips.length; i++) {
                const { path, video } = savedClips[i];
                const row = Math.floor(i / cols);
                const col = i % cols;

                // Video node
                nodes.push({
                    id: `video-${nodeId++}`,
                    type: 'file',
                    file: path,
                    x: col * (clipWidth + spacing),
                    y: row * (clipHeight + spacing + 80),
                    width: clipWidth,
                    height: clipHeight,
                    color: '5'
                });

                // Label
                nodes.push({
                    id: `label-${nodeId++}`,
                    type: 'text',
                    text: `**${video.instructor || 'Unknown'}**\n${video.title || ''}\n_at ${video.timestamp || '0:00'}_\n\n${video.relevance_quote || ''}`,
                    x: col * (clipWidth + spacing),
                    y: row * (clipHeight + spacing + 80) + clipHeight + 10,
                    width: clipWidth,
                    height: 100,
                    color: '0'
                });
            }

            const canvasContent = JSON.stringify({ nodes, edges: [] }, null, 2);

            const existingCanvas = this.app.vault.getAbstractFileByPath(canvasPath);
            if (existingCanvas instanceof TFile) {
                await this.app.vault.modify(existingCanvas, canvasContent);
            } else {
                await this.app.vault.create(canvasPath, canvasContent);
            }

            new Notice(`Created video canvas for "${conceptName}"!`, 5000);

            // Open canvas
            const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
            if (canvasFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(canvasFile);
            }

        } catch (error: any) {
            console.error('Find videos error:', error);
            new Notice(`Failed to find videos: ${error.message}`, 5000);
        }
    }

    /**
     * Video Explorer: Show video breakdown with clickable timestamps.
     * Click a timestamp to generate a clip on-demand.
     */
    async exploreVideoForConcept(file: TFile) {
        const content = await this.app.vault.read(file);
        const conceptName = file.basename;

        // Extract context from summary if available
        const summaryMatch = content.match(/## Summary\n\n([^\n#]+)/);
        const context = summaryMatch ? summaryMatch[1].trim() : '';

        new Notice(`Searching for videos about "${conceptName}"...`, 3000);

        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/explore-video`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    concept: conceptName,
                    context: context
                })
            });

            const data = response.json;

            if (data.error) {
                new Notice(`No videos found for "${conceptName}"`, 3000);
                return;
            }

            // Open the Video Explorer modal
            const modal = new VideoExplorerModal(
                this.app,
                this,
                data,
                file
            );
            modal.open();

        } catch (error: any) {
            console.error('Video explorer error:', error);
            new Notice(`Failed to explore videos: ${error.message}`, 5000);
        }
    }

    /**
     * Find video for Canvas node (right-click menu).
     * First tries to find linked sources from parent article, falls back to semantic search.
     */
    async findVideoForCanvasNodeDirect(node: any) {
        let conceptName = '';
        let sourceFile: TFile | null = null;
        let sessionId: string | null = null;

        if (node.file) {
            sourceFile = node.file;
            conceptName = sourceFile.basename;

            // Try to get session_id from the file's frontmatter
            const cache = this.app.metadataCache.getFileCache(sourceFile);
            if (cache?.frontmatter?.source_rlm_session) {
                sessionId = cache.frontmatter.source_rlm_session;
            }
        } else if (node.text) {
            const text = node.text;
            const match = text.match(/\*\*([^*]+)\*\*/) || text.match(/^#*\s*(.+)$/m);
            conceptName = match ? match[1].trim() : text.substring(0, 50).trim();
        } else if (node.label) {
            conceptName = node.label;
        }

        if (!conceptName) {
            new Notice('Could not get concept name from node');
            return;
        }

        // If we have a session_id, use linked sources from the Oracle article
        if (sessionId) {
            new Notice(`Finding linked sources for "${conceptName}"...`, 3000);

            try {
                const response = await requestUrl({
                    url: `${this.settings.serverUrl}/api/obsidian/sources-for-concept`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.settings.apiToken}`
                    },
                    body: JSON.stringify({
                        session_id: sessionId,
                        concept_name: conceptName
                    })
                });

                const data = response.json;

                if (data.sources && data.sources.length > 0) {
                    new Notice(`Found ${data.sources.length} linked sources!`, 3000);

                    const modal = new LinkedSourcesModal(
                        this.app,
                        this,
                        data,
                        sourceFile || { path: this.settings.syncFolder, parent: null, basename: conceptName } as any
                    );
                    modal.open();
                    return;
                } else {
                    new Notice('No linked sources found, trying semantic search...', 2000);
                }
            } catch (error: any) {
                console.error('Linked sources error:', error);
                new Notice('Linked sources failed, trying semantic search...', 2000);
            }
        }

        // Fallback: semantic search
        new Notice(`Searching for "${conceptName}"...`, 3000);

        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/explore-video`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({ concept: conceptName })
            });

            const data = response.json;

            if (data.error) {
                new Notice(`No video found for "${conceptName}"`, 3000);
                return;
            }

            const modal = new VideoExplorerModal(
                this.app,
                this,
                data,
                sourceFile || { path: this.settings.syncFolder, parent: null, basename: conceptName } as any
            );
            modal.open();

        } catch (error: any) {
            console.error('Canvas video finder error:', error);
            new Notice(`Failed: ${error.message}`, 5000);
        }
    }

    /**
     * Explore series for Canvas node (right-click menu).
     * Uses linked sources from parent article when available.
     */
    async exploreSeriesForCanvasNode(node: any) {
        let conceptName = '';
        let sourceFile: TFile | null = null;
        let sessionId: string | null = null;

        if (node.file) {
            sourceFile = node.file;
            conceptName = sourceFile.basename;

            // Try to get session_id from the file's frontmatter
            const cache = this.app.metadataCache.getFileCache(sourceFile);
            if (cache?.frontmatter?.source_rlm_session) {
                sessionId = cache.frontmatter.source_rlm_session;
            }
        } else if (node.text) {
            const text = node.text;
            const match = text.match(/\*\*([^*]+)\*\*/) || text.match(/^#*\s*(.+)$/m);
            conceptName = match ? match[1].trim() : text.substring(0, 50).trim();
        } else if (node.label) {
            conceptName = node.label;
        }

        if (!conceptName) {
            new Notice('Could not get concept name from node');
            return;
        }

        new Notice(`Finding series for "${conceptName}"${sessionId ? ' (using linked sources)' : ''}...`, 3000);

        try {
            const requestBody: any = { concept: conceptName };
            if (sessionId) {
                requestBody.session_id = sessionId;
            }

            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/explore-series`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify(requestBody)
            });

            const data = response.json;

            if (data.error) {
                new Notice(`No series found for "${conceptName}"`, 3000);
                return;
            }

            new Notice(`Found ${data.total_volumes} volumes!`, 3000);

            const modal = new SeriesExplorerModal(
                this.app,
                this,
                data,
                sourceFile || { path: this.settings.syncFolder, parent: null, basename: conceptName } as any
            );
            modal.open();

        } catch (error: any) {
            console.error('Canvas series finder error:', error);
            new Notice(`Failed: ${error.message}`, 5000);
        }
    }

    /**
     * Show the complete bibliography of videos from the parent Oracle article.
     * User can select any video to see its full concept cache.
     */
    async showArticleBibliography(node: any, sessionId: string) {
        let sourceFile: TFile | null = null;

        if (node.file) {
            sourceFile = node.file;
        }

        new Notice('Loading article bibliography...', 2000);

        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/article-bibliography`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({ session_id: sessionId })
            });

            const data = response.json;

            if (data.error) {
                new Notice(`Error: ${data.error}`, 3000);
                return;
            }

            new Notice(`Found ${data.total_videos} source videos!`, 3000);

            const modal = new ArticleBibliographyModal(
                this.app,
                this,
                data,
                sourceFile || { path: this.settings.syncFolder, parent: null, basename: 'Article' } as any
            );
            modal.open();

        } catch (error: any) {
            console.error('Article bibliography error:', error);
            new Notice(`Failed: ${error.message}`, 5000);
        }
    }

    /**
     * Open the catalog browser for cross-reference research.
     * User can select videos to cross-reference with the concept.
     */
    async openCrossReferenceCatalog(node: any) {
        let conceptName = '';
        let conceptContext = '';
        let sourceFile: TFile | null = null;

        if (node.file) {
            sourceFile = node.file;
            conceptName = sourceFile.basename;

            // Try to get context from frontmatter
            const cache = this.app.metadataCache.getFileCache(sourceFile);
            if (cache?.frontmatter?.cluster) {
                conceptContext = `Part of ${cache.frontmatter.cluster}`;
            }
        } else if (node.text) {
            const text = node.text;
            const match = text.match(/\*\*([^*]+)\*\*/) || text.match(/^#*\s*(.+)$/m);
            conceptName = match ? match[1].trim() : text.substring(0, 50).trim();
        } else if (node.label) {
            conceptName = node.label;
        }

        if (!conceptName) {
            new Notice('Could not get concept name from node');
            return;
        }

        new Notice(`Opening catalog for "${conceptName}"...`, 2000);

        const modal = new CatalogBrowserModal(
            this.app,
            this,
            conceptName,
            conceptContext,
            sourceFile || { path: this.settings.syncFolder, parent: null, basename: conceptName } as any
        );
        modal.open();
    }

    /**
     * Open RLM Enrichment for a checkpoint.
     * Parses the checkpoint file, lets user select videos, enriches with new knowledge.
     */
    async openEnrichCheckpoint(node: any) {
        if (!node.file) {
            new Notice('Checkpoint file not found');
            return;
        }

        const sourceFile = node.file as TFile;
        const cache = this.app.metadataCache.getFileCache(sourceFile);

        if (!cache?.frontmatter || cache.frontmatter.type !== 'checkpoint') {
            new Notice('This is not a checkpoint file');
            return;
        }

        // Parse checkpoint data from file
        const content = await this.app.vault.read(sourceFile);

        // Extract current invariables
        const invariablesMatch = content.match(/## INVARIABLES[\s\S]*?\|[\s\S]*?\|([\s\S]*?)(?=\n---|\n##|$)/);
        const currentInvariables: string[] = [];
        if (invariablesMatch) {
            const links = invariablesMatch[1].match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g) || [];
            for (const link of links) {
                const nameMatch = link.match(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/);
                if (nameMatch && nameMatch[1] !== 'none') {
                    currentInvariables.push(nameMatch[1].trim());
                }
            }
        }

        // Extract current variables
        const variablesMatch = content.match(/## VARIABLES[\s\S]*?((?:- \*\*IF.*\n?)+)/);
        const currentVariables: string[] = [];
        if (variablesMatch) {
            const lines = variablesMatch[1].match(/- \*\*IF[^*]+\*\*[^\n]+/g) || [];
            currentVariables.push(...lines.map(l => l.replace(/^- /, '').trim()));
        }

        // Extract goal
        const goalMatch = content.match(/## Goal\n\n([^\n]+)/);
        const goal = goalMatch ? goalMatch[1].trim() : '';

        // Extract success test
        const successMatch = content.match(/## Success Test\n\n> ([^\n]+)/);
        const successTest = successMatch ? successMatch[1].trim() : '';

        new Notice(`Opening enrichment for "${sourceFile.basename}"...`, 2000);

        const modal = new EnrichCheckpointModal(
            this.app,
            this,
            {
                name: sourceFile.basename,
                cluster: cache.frontmatter.cluster || '',
                currentInvariables,
                currentVariables,
                goal,
                successTest
            },
            sourceFile
        );
        modal.open();
    }

    /**
     * RLM Pipeline - Single button for: Backup → Enrich → Rebuild Canvas
     */
    async runRLMPipeline(canvasView: ItemView) {
        try {
            const canvas = (canvasView as any).canvas;
            if (!canvas) {
                new Notice('Could not access canvas');
                return;
            }

            // Get canvas file
            const canvasFile = (canvasView as any).file as TFile;
            if (!canvasFile) {
                new Notice('Could not determine canvas file');
                return;
            }

            const parentFolder = canvasFile.parent;
            if (!parentFolder) {
                new Notice('Could not determine folder');
                return;
            }

            // Check for subfolder with same name as canvas (common pattern)
            // e.g., "Knee Shield Pass.canvas" → look in "Knee Shield Pass/" subfolder
            const canvasBasename = canvasFile.basename;
            const subfolderPath = `${parentFolder.path}/${canvasBasename}`;
            const subfolder = this.app.vault.getAbstractFileByPath(subfolderPath);

            // Use subfolder if it exists, otherwise use parent folder
            const targetFolderPath = (subfolder && subfolder instanceof TFolder)
                ? subfolderPath
                : parentFolder.path;

            console.log('Canvas:', canvasFile.path);
            console.log('Looking for checkpoints in:', targetFolderPath);

            // Find all checkpoint files in the target folder
            const checkpointFiles: TFile[] = [];

            for (const file of this.app.vault.getFiles()) {
                // Must be markdown in target folder
                if (file.extension !== 'md') continue;
                if (file.parent?.path !== targetFolderPath) continue;

                const cache = this.app.metadataCache.getFileCache(file);
                const frontmatter = cache?.frontmatter;

                if (frontmatter?.type === 'checkpoint') {
                    checkpointFiles.push(file);
                    console.log('Found checkpoint:', file.basename);
                }
            }

            // Sort by order in frontmatter or filename
            checkpointFiles.sort((a, b) => {
                const cacheA = this.app.metadataCache.getFileCache(a);
                const cacheB = this.app.metadataCache.getFileCache(b);
                const orderA = cacheA?.frontmatter?.order || parseInt(a.basename.match(/\[(\d+)\]/)?.[1] || '99');
                const orderB = cacheB?.frontmatter?.order || parseInt(b.basename.match(/\[(\d+)\]/)?.[1] || '99');
                return orderA - orderB;
            });

            console.log('Found checkpoints:', checkpointFiles.map(f => f.basename));

            if (checkpointFiles.length === 0) {
                new Notice(`No checkpoint files found in ${targetFolderPath}. Files need frontmatter: type: checkpoint`);
                return;
            }

            // Get the actual folder object for the target path
            const targetFolder = this.app.vault.getAbstractFileByPath(targetFolderPath) as TFolder;

            // Open the unified RLM Pipeline modal
            const modal = new RLMPipelineModal(
                this.app,
                this,
                canvasFile,
                targetFolder,
                checkpointFiles
            );
            modal.open();

        } catch (error: any) {
            new Notice(`Error: ${error.message}`);
            console.error('RLM Pipeline error:', error);
        }
    }

    /**
     * Rebuild Canvas from checkpoint files - proper layout with all connections.
     * This regenerates the entire canvas from the enriched markdown files.
     */
    async rebuildCanvasFromCheckpoints() {
        // Get active file to determine folder
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Open a file in the checkpoint folder first');
            return;
        }

        const folder = activeFile.parent;
        if (!folder) {
            new Notice('Could not determine folder');
            return;
        }

        new Notice(`Scanning ${folder.path} for checkpoints...`);

        try {
            // Find all checkpoint files in the folder
            const checkpoints: any[] = [];
            const methods: any[] = [];

            for (const file of this.app.vault.getFiles()) {
                if (!file.path.startsWith(folder.path) || file.extension !== 'md') continue;

                const cache = this.app.metadataCache.getFileCache(file);
                if (!cache?.frontmatter) continue;

                const type = cache.frontmatter.type;

                if (type === 'checkpoint') {
                    const content = await this.app.vault.read(file);

                    // Parse order from frontmatter or filename
                    const order = cache.frontmatter.order || parseInt(file.basename.match(/^\[?(\d+)/)?.[1] || '99');

                    // Extract linked invariables
                    const invariables: string[] = [];
                    const invMatch = content.match(/## INVARIABLES[\s\S]*?\|([\s\S]*?)(?=\n##|\n---)/);
                    if (invMatch) {
                        const links = invMatch[1].match(/\[\[([^\]|]+)/g) || [];
                        for (const link of links) {
                            const name = link.replace('[[', '').trim();
                            if (name && name !== 'none') {
                                invariables.push(name);
                            }
                        }
                    }

                    // Extract navigation links
                    const navigation: string[] = [];
                    const navMatch = content.match(/## Navigation[\s\S]*?((?:\[\[[^\]]+\]\][^\n]*\n?)+)/);
                    if (navMatch) {
                        const navLinks = navMatch[1].match(/\[\[([^\]|]+)/g) || [];
                        for (const link of navLinks) {
                            navigation.push(link.replace('[[', '').trim());
                        }
                    }

                    checkpoints.push({
                        file,
                        order,
                        cluster: cache.frontmatter.cluster || '',
                        invariables,
                        navigation
                    });
                } else if (type === 'method' || type === 'concept') {
                    methods.push({
                        file,
                        tier: cache.frontmatter.tier || 'REFINEMENT',
                        cluster: cache.frontmatter.cluster || ''
                    });
                }
            }

            if (checkpoints.length === 0) {
                new Notice('No checkpoint files found in this folder');
                return;
            }

            // Sort checkpoints by order
            checkpoints.sort((a, b) => a.order - b.order);

            new Notice(`Found ${checkpoints.length} checkpoints, ${methods.length} methods. Building canvas...`);

            // Build canvas JSON
            const canvasData: any = {
                nodes: [],
                edges: []
            };

            // Layout constants
            const checkpointWidth = 300;
            const checkpointHeight = 150;
            const methodWidth = 200;
            const methodHeight = 80;
            const horizontalGap = 400;
            const verticalGap = 200;
            const methodOffsetX = 350;
            const methodGap = 100;

            // Create checkpoint nodes in a horizontal flow
            let currentX = 100;
            const checkpointY = 300;
            const nodeIdMap: Map<string, string> = new Map();

            for (let i = 0; i < checkpoints.length; i++) {
                const cp = checkpoints[i];
                const nodeId = `checkpoint-${i}`;
                nodeIdMap.set(cp.file.basename, nodeId);

                canvasData.nodes.push({
                    id: nodeId,
                    type: 'file',
                    file: cp.file.path,
                    x: currentX,
                    y: checkpointY,
                    width: checkpointWidth,
                    height: checkpointHeight,
                    color: '4' // Blue for checkpoints
                });

                // Add method nodes for invariables (stacked above)
                let methodY = checkpointY - methodGap - methodHeight;
                for (const invName of cp.invariables) {
                    // Find the method file
                    const methodFile = methods.find(m => m.file.basename === invName);
                    if (methodFile) {
                        const methodId = `method-${nodeIdMap.size}`;
                        nodeIdMap.set(invName, methodId);

                        canvasData.nodes.push({
                            id: methodId,
                            type: 'file',
                            file: methodFile.file.path,
                            x: currentX + methodOffsetX,
                            y: methodY,
                            width: methodWidth,
                            height: methodHeight,
                            color: methodFile.tier === 'CRITICAL' ? '1' : methodFile.tier === 'IMPORTANT' ? '6' : '0'
                        });

                        // Edge from checkpoint to method
                        canvasData.edges.push({
                            id: `edge-${canvasData.edges.length}`,
                            fromNode: nodeId,
                            fromSide: 'right',
                            toNode: methodId,
                            toSide: 'left'
                        });

                        methodY -= methodHeight + 30;
                    }
                }

                // Edge to next checkpoint
                if (i < checkpoints.length - 1) {
                    canvasData.edges.push({
                        id: `edge-cp-${i}`,
                        fromNode: nodeId,
                        fromSide: 'right',
                        toNode: `checkpoint-${i + 1}`,
                        toSide: 'left',
                        color: '5'
                    });
                }

                currentX += horizontalGap;
            }

            // Add navigation edges between checkpoints
            for (const cp of checkpoints) {
                const fromId = nodeIdMap.get(cp.file.basename);
                for (const navTarget of cp.navigation) {
                    const toId = nodeIdMap.get(navTarget);
                    if (fromId && toId && fromId !== toId) {
                        // Check if edge already exists
                        const exists = canvasData.edges.some((e: any) =>
                            e.fromNode === fromId && e.toNode === toId
                        );
                        if (!exists) {
                            canvasData.edges.push({
                                id: `edge-nav-${canvasData.edges.length}`,
                                fromNode: fromId,
                                fromSide: 'bottom',
                                toNode: toId,
                                toSide: 'top',
                                color: '3' // Green for navigation
                            });
                        }
                    }
                }
            }

            // Save canvas file
            const canvasPath = `${folder.path}/${folder.name} - Generated.canvas`;
            const canvasContent = JSON.stringify(canvasData, null, 2);

            const existingCanvas = this.app.vault.getAbstractFileByPath(canvasPath);
            if (existingCanvas) {
                await this.app.vault.modify(existingCanvas as TFile, canvasContent);
            } else {
                await this.app.vault.create(canvasPath, canvasContent);
            }

            new Notice(`Canvas created: ${canvasPath}`);

            // Open the canvas
            const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
            if (canvasFile) {
                await this.app.workspace.getLeaf().openFile(canvasFile as TFile);
            }

        } catch (error: any) {
            new Notice(`Error: ${error.message}`);
            console.error('Rebuild canvas error:', error);
        }
    }

    /**
     * Extract WebM clip from a method node - shows clip browser with options.
     */
    async extractClipFromMethod(file: TFile, frontmatter: any) {
        const { video_id, source_instructor } = frontmatter;
        const conceptName = file.basename;

        if (!video_id) {
            new Notice('No video_id found - cannot extract clip');
            return;
        }

        new Notice(`Finding clip options for "${conceptName}"...`);

        try {
            // Call API to get clip options from transcription
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/clip-options`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    video_id: video_id,
                    concept: conceptName,
                    instructor: source_instructor || ''
                })
            });

            const data = response.json;

            if (data.error) {
                new Notice(`Error: ${data.error}`);
                return;
            }

            // Open clip browser modal
            const modal = new ClipBrowserModal(
                this.app,
                this,
                file,
                data
            );
            modal.open();

        } catch (error: any) {
            new Notice(`Error finding clips: ${error.message}`);
            console.error('Clip options error:', error);
        }
    }

    /**
     * Actually extract a WebM clip after user selects it.
     */
    async doExtractClip(videoId: string, startTime: number, duration: number, outputName: string): Promise<string | null> {
        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/extract-clip`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    video_id: videoId,
                    start_time: startTime,
                    duration: duration,
                    output_name: outputName
                })
            });

            const data = response.json;
            if (data.clip_path) {
                return data.clip_path;
            }
            return null;
        } catch (error) {
            console.error('Extract clip error:', error);
            return null;
        }
    }

    /**
     * Find video for selected Canvas node.
     * Shows concept cache with clickable timestamps.
     */
    async findVideoForCanvasNode(canvasView: ItemView) {
        try {
            // Access the canvas through the view
            const canvas = (canvasView as any).canvas;
            if (!canvas) {
                new Notice('Could not access canvas');
                return;
            }

            // Get selected nodes
            const selection = canvas.selection;
            if (!selection || selection.size === 0) {
                new Notice('Select a concept node in the canvas first');
                return;
            }

            // Get the first selected node
            const selectedNode = Array.from(selection)[0] as any;

            // Get concept name from node
            let conceptName = '';
            let sourceFile: TFile | null = null;

            if (selectedNode.file) {
                // File node - get the linked file
                sourceFile = selectedNode.file;
                conceptName = sourceFile.basename;
            } else if (selectedNode.text) {
                // Text node - extract concept from text
                const text = selectedNode.text;
                // Try to extract a concept name (first line or bold text)
                const match = text.match(/\*\*([^*]+)\*\*/) || text.match(/^#*\s*(.+)$/m);
                conceptName = match ? match[1].trim() : text.substring(0, 50).trim();
            } else {
                new Notice('Select a concept node (file or text node)');
                return;
            }

            if (!conceptName) {
                new Notice('Could not determine concept name from node');
                return;
            }

            new Notice(`Finding video for "${conceptName}"...`, 3000);

            // Call the explore-video API
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/explore-video`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    concept: conceptName
                })
            });

            const data = response.json;

            if (data.error) {
                new Notice(`No video found for "${conceptName}"`, 3000);
                return;
            }

            // Create a temporary file reference for the modal
            const tempFile = sourceFile || this.app.vault.getAbstractFileByPath(
                `${this.settings.syncFolder}/temp-concept.md`
            ) as TFile;

            // Open the Video Explorer modal
            const modal = new VideoExplorerModal(
                this.app,
                this,
                data,
                tempFile || { path: this.settings.syncFolder, parent: null, basename: conceptName } as any
            );
            modal.open();

        } catch (error: any) {
            console.error('Canvas video finder error:', error);
            new Notice(`Failed to find video: ${error.message}`, 5000);
        }
    }

    /**
     * Series Explorer: Show all volumes in a video series with clickable timestamps.
     */
    async exploreSeriesForConcept(file: TFile) {
        const content = await this.app.vault.read(file);
        const conceptName = file.basename;

        new Notice(`Searching for video series about "${conceptName}"...`, 3000);

        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/explore-series`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    concept: conceptName
                })
            });

            const data = response.json;

            if (data.error) {
                new Notice(`No video series found for "${conceptName}"`, 3000);
                return;
            }

            new Notice(`Found ${data.total_volumes} volumes in "${data.series_name}"!`, 3000);

            // Open the Series Explorer modal
            const modal = new SeriesExplorerModal(
                this.app,
                this,
                data,
                file
            );
            modal.open();

        } catch (error: any) {
            console.error('Series explorer error:', error);
            new Notice(`Failed to explore series: ${error.message}`, 5000);
        }
    }

    /**
     * Generate a clip on-demand and save to vault.
     */
    async generateClipOnDemand(videoId: string, timestampSeconds: number, targetFolder: string): Promise<string | null> {
        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/generate-clip-on-demand`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    video_id: videoId,
                    timestamp_seconds: timestampSeconds,
                    duration: 60
                })
            });

            const clipData = response.json;
            if (!clipData.clip_url) {
                return null;
            }

            // Download the clip
            const clipResponse = await requestUrl({
                url: `${this.settings.serverUrl}${clipData.clip_url}`,
                method: 'GET'
            });

            // Save to vault
            const clipFilename = `${videoId}_${timestampSeconds}s.webm`;
            const clipPath = `${targetFolder}/${clipFilename}`;
            await this.ensureFolder(targetFolder);
            await this.app.vault.adapter.writeBinary(clipPath, clipResponse.arrayBuffer);

            return clipPath;

        } catch (error) {
            console.error('Clip generation error:', error);
            return null;
        }
    }

    async coachShowPending() {
        if (!this.coachClient) {
            new Notice('Coach mode not configured');
            return;
        }

        try {
            const pending = await this.coachClient.getPendingJobs();

            if (pending.length === 0) {
                new Notice('No pending queries');
                return;
            }

            // Open inbox folder
            const inboxFolder = `${this.settings.syncFolder}/Inbox`;
            await this.ensureFolder(inboxFolder);

            // Sync latest
            for (const job of pending) {
                const filename = `${inboxFolder}/${job.job_id.substring(0, 8)} - ${job.athlete_name || 'Unknown'}.md`;
                if (!(await this.app.vault.adapter.exists(filename))) {
                    const content = this.createPendingQueryNote(job);
                    await this.saveNote(filename, content);
                }
            }

            new Notice(`${pending.length} pending queries in Inbox`);

            // Open first pending note
            const firstFile = this.app.vault.getAbstractFileByPath(
                `${inboxFolder}/${pending[0].job_id.substring(0, 8)} - ${pending[0].athlete_name || 'Unknown'}.md`
            );
            if (firstFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(firstFile);
            }
        } catch (error) {
            console.error('Error fetching pending:', error);
            new Notice('Failed to fetch pending queries');
        }
    }

    async coachGenerateArticle(view: MarkdownView) {
        if (!this.coachClient) {
            new Notice('Coach mode not configured');
            return;
        }

        const file = view.file;
        if (!file) return;

        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter;

        if (!frontmatter?.job_id) {
            new Notice('Not a pending query note (no job_id in frontmatter)');
            return;
        }

        const jobId = frontmatter.job_id;
        const query = frontmatter.query_text || await this.extractQueryFromNote(view);

        if (!query) {
            new Notice('Could not find query text');
            return;
        }

        new Notice('Claiming job and generating article...');

        try {
            // Claim the job
            await this.coachClient.claimJob(jobId);

            // Generate via local Oracle
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/research`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, user_id: 'coach' })
            });

            const article = response.json.article || response.json.research?.article_raw || '';
            const sources = response.json.sources || response.json.research?.sources || [];

            // Update the note with generated article
            let content = await this.app.vault.read(file);

            // Replace placeholder with article
            const placeholder = '*Run "Coach: Generate article" to populate this section*';
            if (content.includes(placeholder)) {
                content = content.replace(placeholder, article);
            } else {
                // Append to end
                content += `\n\n${article}`;
            }

            // Update frontmatter status
            content = content.replace('status: pending', 'status: draft');

            await this.app.vault.modify(file, content);

            // Move to Drafts folder
            const draftsFolder = `${this.settings.syncFolder}/Drafts`;
            await this.ensureFolder(draftsFolder);
            const newPath = `${draftsFolder}/${file.name}`;
            await this.app.fileManager.renameFile(file, newPath);

            new Notice('Article generated! Edit and then push to athlete.');
        } catch (error) {
            console.error('Generate error:', error);
            new Notice('Failed to generate article');
        }
    }

    async extractQueryFromNote(view: MarkdownView): Promise<string | null> {
        const content = view.getViewData();
        const match = content.match(/## Question\n\n([\s\S]*?)(?=\n---|\n##|$)/);
        return match ? match[1].trim() : null;
    }

    async coachPushArticle(view: MarkdownView) {
        console.log('[Flipmode] coachPushArticle called');
        new Notice('Starting push...');

        if (!this.coachClient) {
            new Notice('Coach mode not configured - check settings');
            console.log('[Flipmode] coachClient is null, mode:', this.settings.mode, 'token:', this.settings.coachToken?.substring(0, 8));
            return;
        }

        const file = view.file;
        if (!file) {
            new Notice('No file open');
            console.log('[Flipmode] No file in view');
            return;
        }

        const content = await this.app.vault.read(file);
        console.log('[Flipmode] Push article - file:', file.path);

        // Parse frontmatter from content
        let jobId: string | null = null;
        let athleteName: string | null = null;
        let sourceFile: string | null = null;
        let fileType: string | null = null;

        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fmMatch) {
            const fmContent = fmMatch[1];
            const typeMatch = fmContent.match(/type:\s*(.+)/);
            const jobIdMatch = fmContent.match(/job_id:\s*(.+)/);
            const athleteMatch = fmContent.match(/athlete_name:\s*(.+)/);
            const sourceMatch = fmContent.match(/source_file:\s*"?\[\[([^\]]+)\]\]"?/);

            if (typeMatch) fileType = typeMatch[1].trim();
            if (jobIdMatch) jobId = jobIdMatch[1].trim();
            if (athleteMatch) athleteName = athleteMatch[1].trim();
            if (sourceMatch) sourceFile = sourceMatch[1].trim();
        }

        console.log('[Flipmode] File type:', fileType, 'job_id:', jobId, 'source_file:', sourceFile);

        // If this is a Training Review, get job_id from the linked source query
        if (fileType === 'training-review' && sourceFile && !jobId) {
            console.log('[Flipmode] Training Review - looking up source query:', sourceFile);

            // Find the source file
            const sourceFilePath = this.app.metadataCache.getFirstLinkpathDest(sourceFile, file.path);
            if (sourceFilePath) {
                const sourceContent = await this.app.vault.read(sourceFilePath);
                const sourceFmMatch = sourceContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                if (sourceFmMatch) {
                    const sourceFm = sourceFmMatch[1];
                    const sourceJobId = sourceFm.match(/job_id:\s*(.+)/);
                    const sourceAthlete = sourceFm.match(/athlete_name:\s*(.+)/);
                    if (sourceJobId) jobId = sourceJobId[1].trim();
                    if (sourceAthlete) athleteName = sourceAthlete[1].trim();
                    console.log('[Flipmode] Got from source - job_id:', jobId, 'athlete:', athleteName);
                }
            } else {
                console.log('[Flipmode] Could not find source file:', sourceFile);
            }
        }

        if (!jobId) {
            new Notice('Cannot push: no job_id found (check source query link)');
            return;
        }

        // For Training Reviews, use the main content (after frontmatter, skip the warning banner)
        let article: string;
        if (fileType === 'training-review') {
            // Remove frontmatter and warning banner, get the actual content
            const contentAfterFm = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
            // Remove the draft warning block and "Listen to Review" block
            article = contentAfterFm
                .replace(/> \[!warning\][\s\S]*?(?=\n## |\n# )/g, '')
                .replace(/## Listen to Review[\s\S]*?(?=\n## |\n# )/g, '')
                .replace(/## Deep Dive[\s\S]*?(?=\n## |$)/g, '')
                .replace(/## Links[\s\S]*$/g, '')
                .trim();
        } else {
            // For query notes, extract from "## Generated Article" section
            const articleMatch = content.match(/## Generated Article\n\n([\s\S]*?)$/);
            article = articleMatch ? articleMatch[1].trim() : '';
        }

        if (!article || article.includes('Run "Coach: Generate article"')) {
            new Notice('No article content to push');
            return;
        }

        console.log('[Flipmode] Article length:', article.length);

        new Notice('Pushing to athlete...');

        try {
            // First claim the job (moves from pending → processing)
            try {
                await this.coachClient.claimJob(jobId);
                console.log('[Flipmode] Job claimed');
            } catch (claimErr) {
                // May already be claimed, continue anyway
                console.log('[Flipmode] Claim skipped (may already be processing):', claimErr);
            }

            // Then complete it
            const success = await this.coachClient.completeJob(jobId, article, []);

            if (success) {
                // Update status in frontmatter
                let updatedContent = content.replace('status: draft', 'status: synced');
                updatedContent = updatedContent.replace('status: pending', 'status: synced');
                await this.app.vault.modify(file, updatedContent);

                // Move to Sent folder with "synced" in filename
                const sentFolder = `${this.settings.syncFolder}/Sent`;
                await this.ensureFolder(sentFolder);

                // Rename to show synced status, preserving original name structure
                const baseName = file.basename.replace(/ \[synced\]$/, ''); // Remove if already there
                const newFileName = `${baseName} [synced].md`;
                const newPath = `${sentFolder}/${newFileName}`;
                await this.app.fileManager.renameFile(file, newPath);

                // Also update the source query note status
                if (sourceFile) {
                    const sourceFilePath = this.app.metadataCache.getFirstLinkpathDest(sourceFile, file.path);
                    if (sourceFilePath) {
                        const sourceContent = await this.app.vault.read(sourceFilePath);
                        const updatedSource = sourceContent.replace('status: pending', 'status: synced');
                        await this.app.vault.modify(sourceFilePath, updatedSource);
                    }
                }

                new Notice(`Pushed to ${athleteName || 'athlete'}!`);
            } else {
                new Notice('Failed to push - check connection');
            }
        } catch (error) {
            console.error('Push error:', error);
            new Notice('Failed to push article');
        }
    }

    async coachPushConcepts() {
        if (!this.coachClient) {
            new Notice('Coach mode not configured');
            return;
        }

        // Read all concept files from concepts folder
        const conceptsFolder = `${this.settings.syncFolder}/${this.settings.conceptsSubfolder}`;
        const conceptFiles = this.app.vault.getMarkdownFiles().filter(f =>
            f.path.startsWith(conceptsFolder) && !f.basename.startsWith('_')
        );

        if (conceptFiles.length === 0) {
            new Notice('No concepts found. Use "Explode to Concept Graph" first.');
            return;
        }

        // Parse concepts from files
        const concepts: any[] = [];
        for (const file of conceptFiles) {
            const content = await this.app.vault.read(file);
            const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmMatch) continue;

            const fm = fmMatch[1];
            const name = file.basename;
            const category = fm.match(/tags:.*?(\w+)\]$/m)?.[1] || 'technique';
            const parent = fm.match(/parent:\s*"([^"]+)"/)?.[1] || null;

            // Extract summary
            const summaryMatch = content.match(/## Summary\n\n([\s\S]*?)(?=\n## |$)/);
            const summary = summaryMatch ? summaryMatch[1].trim() : '';

            // Extract linked concepts
            const prereqMatch = content.match(/## Prerequisites\n\n([\s\S]*?)(?=\n## |$)/);
            const leadsToMatch = content.match(/## Leads To\n\n([\s\S]*?)(?=\n## |$)/);
            const countersMatch = content.match(/## Counters\n\n([\s\S]*?)(?=\n## |$)/);
            const relatedMatch = content.match(/## Related Concepts\n\n([\s\S]*?)(?=\n## |$)/);

            const extractLinks = (text: string | undefined): string[] => {
                if (!text) return [];
                const links = text.match(/\[\[([^\]]+)\]\]/g) || [];
                return links.map(l => l.replace(/\[\[|\]\]/g, ''));
            };

            concepts.push({
                name,
                category,
                parent,
                summary,
                prerequisites: extractLinks(prereqMatch?.[1]),
                leads_to: extractLinks(leadsToMatch?.[1]),
                counters: extractLinks(countersMatch?.[1]),
                related: extractLinks(relatedMatch?.[1])
            });
        }

        if (concepts.length === 0) {
            new Notice('No valid concepts found');
            return;
        }

        // Ask which athlete to push to
        new CoachPushConceptsModal(this.app, this, concepts).open();
    }

    async coachAddAthlete() {
        if (!this.coachClient) {
            new Notice('Coach mode not configured');
            return;
        }

        new CoachAddAthleteModal(this.app, this).open();
    }

    async ensureFolder(path: string) {
        if (!(await this.app.vault.adapter.exists(path))) {
            await this.app.vault.createFolder(path);
        }
    }

    async saveNote(path: string, content: string) {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
        } else {
            await this.app.vault.create(path, content);
        }
    }

    // Remote mode methods
    initRemoteMode() {
        this.queueClient = new RemoteQueueClient(
            this.settings.queueServiceUrl,
            this.settings.athleteToken
        );

        // Start polling for results
        this.startResultPolling();

        // Update status bar
        this.updateStatusBar('Remote Mode');
    }

    startResultPolling() {
        if (this.pollIntervalId) {
            window.clearInterval(this.pollIntervalId);
        }

        this.pollIntervalId = window.setInterval(
            () => this.pollPendingJobs(),
            this.settings.pollInterval * 1000
        );
    }

    async pollPendingJobs() {
        if (!this.queueClient || this.pendingJobs.size === 0) return;

        for (const [jobId, job] of this.pendingJobs.entries()) {
            if (job.status === 'complete' || job.status === 'error') continue;

            try {
                const status = await this.queueClient.checkStatus(jobId);

                if (status.status === 'complete') {
                    // Fetch full result
                    const result = await this.queueClient.getResult(jobId);

                    if (result.error) {
                        job.status = 'error';
                        new Notice(`Query failed: ${result.error}`);
                    } else {
                        job.status = 'complete';

                        // Save to vault
                        const filename = await this.saveArticleToVault(job.query, result.article);
                        new Notice(`Research ready! Saved to ${filename}`);

                        // Remove from pending
                        this.pendingJobs.delete(jobId);
                    }
                } else if (status.status === 'processing') {
                    job.status = 'processing';
                } else if (status.status === 'error') {
                    job.status = 'error';
                    this.pendingJobs.delete(jobId);
                }
            } catch (error) {
                console.error(`Error polling job ${jobId}:`, error);
            }
        }
    }

    async submitToCoach(query: string, therapyContext?: any): Promise<string | null> {
        if (!this.queueClient) {
            new Notice('Remote mode not configured. Check settings.');
            return null;
        }

        try {
            const { jobId } = await this.queueClient.submitQuery(query, therapyContext);

            // Track the job
            this.pendingJobs.set(jobId, {
                jobId,
                query,
                submittedAt: new Date(),
                status: 'pending'
            });

            // Create pending note in vault
            await this.createPendingJobNote(jobId, query);

            new Notice('Query sent to Oracle! You\'ll be notified when ready.');
            return jobId;
        } catch (error) {
            console.error('Failed to submit query:', error);
            new Notice('Failed to send query to Oracle. Check your connection.');
            return null;
        }
    }

    async createPendingJobNote(jobId: string, query: string) {
        const date = new Date().toISOString().split('T')[0];
        const time = new Date().toLocaleTimeString();
        const cleanQuery = query.substring(0, 40).replace(/[\\/:*?"<>|]/g, '-');
        const folder = `${this.settings.syncFolder}/Pending`;

        // Ensure folder exists
        const folderObj = this.app.vault.getAbstractFileByPath(folder);
        if (!folderObj) {
            await this.app.vault.createFolder(folder);
        }

        const filename = `${folder}/${date} - ${cleanQuery}.md`;
        const content = `---
type: pending-query
job_id: ${jobId}
submitted: ${date} ${time}
status: pending
---

# Pending Query

**Submitted:** ${date} ${time}

**Query:** ${query}

---

*Waiting for Oracle to process...*

This note will be updated when results are ready.
`;

        await this.app.vault.create(filename, content);
    }

    showPendingJobsModal() {
        new PendingJobsModal(this.app, this).open();
    }

    async connectWithDiscord() {
        if (!this.settings.queueServiceUrl) {
            new Notice('Configure Queue Service URL in settings first');
            return;
        }

        // Open Discord OAuth URL in browser
        const authUrl = `${this.settings.queueServiceUrl}/auth/discord`;
        window.open(authUrl, '_blank');

        new Notice('Complete Discord login in browser, then paste your token in settings');
    }

    async syncGraphToCoach() {
        if (!this.queueClient) return;

        try {
            const files = this.app.vault.getMarkdownFiles();
            const flipmodeFiles = files.filter(f => f.path.startsWith(this.settings.syncFolder));

            const graphData = {
                sessions: [] as any[],
                queries: [] as any[],
                topics: [] as string[]
            };

            for (const file of flipmodeFiles) {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter || {};
                const type = fm.type;

                if (type === 'training-session') {
                    graphData.sessions.push({
                        date: fm.date,
                        tags: fm.tags || []
                    });
                }

                if (type === 'research' && fm.topic) {
                    graphData.queries.push({
                        topic: fm.topic,
                        date: fm.date
                    });
                    graphData.topics.push(fm.topic);
                }

                if (type === 'pending-query') {
                    graphData.queries.push({
                        topic: fm.query || file.basename,
                        date: fm.submitted,
                        pending: true
                    });
                }
            }

            // Dedupe topics
            graphData.topics = [...new Set(graphData.topics)];

            await this.queueClient.syncGraph(graphData);
            new Notice(`Synced: ${graphData.sessions.length} sessions, ${graphData.queries.length} queries`);
        } catch (error) {
            console.error('Graph sync error:', error);
            new Notice('Failed to sync graph');
        }
    }

    onunload() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }
        if (this.pollIntervalId) {
            window.clearInterval(this.pollIntervalId);
        }
    }

    async syncFromCoach() {
        if (!this.queueClient) {
            new Notice('Remote mode not configured - check settings');
            return;
        }

        new Notice('Checking for completed research...');

        try {
            const jobs = await this.queueClient.listJobs();
            const completedJobs = jobs.filter((j: any) => j.status === 'complete');

            if (completedJobs.length === 0) {
                new Notice('No completed research to sync');
                return;
            }

            let synced = 0;
            for (const job of completedJobs) {
                // Check if already saved (look for file with job_id in frontmatter)
                const existingFile = this.findFileByJobId(job.job_id);
                if (existingFile) {
                    console.log('[Flipmode] Already synced:', job.job_id);
                    continue;
                }

                // Fetch full result
                const result = await this.queueClient.getResult(job.job_id);
                if (result.article) {
                    const filename = await this.saveCoachArticleToVault(job, result);
                    console.log('[Flipmode] Synced:', filename);
                    synced++;
                }
            }

            // Also sync concepts
            let conceptsSynced = 0;
            try {
                const concepts = await this.queueClient.getConcepts();
                if (concepts.length > 0) {
                    conceptsSynced = await this.syncConceptsToVault(concepts);
                }
            } catch (err) {
                console.log('[Flipmode] No concepts to sync or error:', err);
            }

            if (synced > 0 || conceptsSynced > 0) {
                const msg = [];
                if (synced > 0) msg.push(`${synced} research article(s)`);
                if (conceptsSynced > 0) msg.push(`${conceptsSynced} concept(s)`);
                new Notice(`Synced ${msg.join(' and ')} from Oracle!`);
            } else {
                new Notice('All research already synced');
            }
        } catch (error) {
            console.error('[Flipmode] Sync error:', error);
            new Notice('Failed to sync from Oracle');
        }
    }

    async syncConceptsToVault(concepts: any[]): Promise<number> {
        const folder = `${this.settings.syncFolder}/${this.settings.conceptsSubfolder}`;
        await this.ensureFolder(folder);

        let created = 0;
        for (const concept of concepts) {
            const conceptName = concept.name.replace(/[^\w\s-]/g, '').trim();
            const conceptPath = `${folder}/${conceptName}.md`;

            // Check if exists
            const existing = this.app.vault.getAbstractFileByPath(conceptPath);
            if (existing) continue;

            // Build linked markdown
            const parentLink = concept.parent ? `[[${concept.parent}]]` : 'Root concept';
            const prereqLinks = (concept.prerequisites || []).map((p: string) => `- [[${p}]]`).join('\n') || '- None';
            const leadsToLinks = (concept.leads_to || []).map((l: string) => `- [[${l}]]`).join('\n') || '- None';
            const counterLinks = (concept.counters || []).map((c: string) => `- [[${c}]]`).join('\n') || '- None';
            const relatedLinks = (concept.related || []).map((r: string) => `- [[${r}]]`).join('\n') || '- None';

            const content = `---
type: concept
parent: "${concept.parent || ''}"
tags: [concept, grappling, ${concept.category?.toLowerCase() || 'technique'}]
---

# ${concept.name}

**Category:** ${concept.category || 'Technique'}
**Parent:** ${parentLink}

## Summary

${concept.summary || 'No summary available.'}

## Prerequisites

${prereqLinks}

## Leads To

${leadsToLinks}

## Counters

${counterLinks}

## Related Concepts

${relatedLinks}
`;

            await this.app.vault.create(conceptPath, content);
            created++;
        }

        return created;
    }

    findFileByJobId(jobId: string): TFile | null {
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter?.job_id === jobId) {
                return file;
            }
        }
        return null;
    }

    async saveCoachArticleToVault(job: any, result: any): Promise<string> {
        const folder = `${this.settings.syncFolder}/Research`;
        await this.ensureFolder(folder);

        const date = new Date().toISOString().split('T')[0];
        const shortQuery = (job.enriched_query || job.query_text || 'Research')
            .substring(0, 50)
            .replace(/[^\w\s-]/g, '')
            .trim();

        const filename = `${folder}/${date} - ${shortQuery}.md`;

        const content = `---
type: oracle-research
job_id: ${job.job_id}
query: "${job.enriched_query || job.query_text}"
received: ${new Date().toISOString()}
rlm_session_id: ${result.rlm_session_id || ''}
tags: [bjj, research, from-oracle]
---

# Research: ${shortQuery}

${result.article}

---
*Research provided by Oracle*
`;

        await this.app.vault.create(filename, content);
        return filename;
    }

    isRemoteMode(): boolean {
        return this.settings.mode === 'remote' && !!this.queueClient;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateStatusBar(status: string) {
        this.statusBarItem.setText(`Flipmode: ${status}`);
    }

    // API Methods
    async apiRequest(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
        const url = `${this.settings.serverUrl}/api/obsidian${endpoint}`;

        try {
            const response = await requestUrl({
                url,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: body ? JSON.stringify(body) : undefined
            });

            return response.json;
        } catch (error) {
            console.error('Flipmode API error:', error);
            throw error;
        }
    }

    // Remote transcription for athletes (uses Heroku OpenAI Whisper)
    async remoteTranscribe(audioBlob: Blob): Promise<{text: string, duration: number, usage: any}> {
        if (!this.settings.queueServiceUrl || !this.settings.athleteToken) {
            throw new Error('Remote transcription requires queue service URL and athlete token');
        }

        // Convert blob to base64 using FileReader (works better on mobile)
        const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result as string;
                // Remove the data:audio/webm;base64, prefix
                const base64Data = dataUrl.split(',')[1];
                resolve(base64Data);
            };
            reader.onerror = reject;
            reader.readAsDataURL(audioBlob);
        });

        console.log('[Flipmode] Sending voice note to:', this.settings.queueServiceUrl);
        console.log('[Flipmode] Audio size:', audioBlob.size, 'bytes, base64 length:', base64.length);

        const response = await requestUrl({
            url: `${this.settings.queueServiceUrl}/api/voice/transcribe`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.athleteToken}`
            },
            body: JSON.stringify({ audio_base64: base64 })
        });

        if (response.status >= 400) {
            throw new Error(response.json?.error || 'Transcription failed');
        }

        return response.json;
    }

    // Check voice note usage for today
    async getVoiceUsage(): Promise<{count: number, remaining: number, limit: number}> {
        if (!this.settings.queueServiceUrl || !this.settings.athleteToken) {
            throw new Error('Requires queue service URL and athlete token');
        }

        const response = await requestUrl({
            url: `${this.settings.queueServiceUrl}/api/voice/usage`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.settings.athleteToken}`
            }
        });

        return response.json;
    }

    // Start remote therapy session (after transcription)
    async startRemoteTherapy(transcript: string): Promise<{session_id: string, state: string, question?: string, enriched_query?: string}> {
        if (!this.settings.queueServiceUrl || !this.settings.athleteToken) {
            throw new Error('Requires queue service URL and athlete token');
        }

        const response = await requestUrl({
            url: `${this.settings.queueServiceUrl}/api/therapy/start`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.athleteToken}`
            },
            body: JSON.stringify({ transcript })
        });

        if (response.status >= 400) {
            throw new Error(response.json?.error || 'Failed to start therapy session');
        }

        return response.json;
    }

    // Continue remote therapy session with answer
    async respondToRemoteTherapy(sessionId: string, answer: string): Promise<{session_id: string, state: string, question?: string, enriched_query?: string}> {
        if (!this.settings.queueServiceUrl || !this.settings.athleteToken) {
            throw new Error('Requires queue service URL and athlete token');
        }

        const response = await requestUrl({
            url: `${this.settings.queueServiceUrl}/api/therapy/respond`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.athleteToken}`
            },
            body: JSON.stringify({ session_id: sessionId, answer })
        });

        if (response.status >= 400) {
            throw new Error(response.json?.error || 'Failed to continue therapy session');
        }

        return response.json;
    }

    async checkConnection(): Promise<boolean> {
        try {
            const response = await this.apiRequest('/health');
            if (response.status === 'healthy') {
                this.updateStatusBar('Connected');
                return true;
            }
        } catch (error) {
            this.updateStatusBar('Disconnected');
        }
        return false;
    }

    // Save article to vault with frontmatter for graph view
    async saveArticleToVault(topic: string, articleContent: string): Promise<string> {
        // Clean topic for filename and wikilink
        const cleanTopic = topic.replace(/[\\/:*?"<>|]/g, '-').substring(0, 50);
        const timestamp = new Date().toISOString().split('T')[0];
        const filename = `${this.settings.syncFolder}/${timestamp} - ${cleanTopic}.md`;

        // Extract keywords for tags (simple word extraction)
        const keywords = topic.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 3 && !['when', 'from', 'with', 'that', 'this', 'what', 'how'].includes(w))
            .slice(0, 5);

        // Add frontmatter and wikilinks for graph view
        const frontmatter = `---
type: research
topic: "[[${cleanTopic}]]"
date: ${timestamp}
tags: [bjj, flipmode${keywords.map(k => `, ${k}`).join('')}]
---

`;
        // Add related links section at the end
        const relatedLinks = `

---
## Related
- Topic: [[${cleanTopic}]]
- Training Plan: [[${timestamp} - ${cleanTopic} Plan]]

*Generated by Flipmode*
`;

        const fullContent = frontmatter + articleContent + relatedLinks;

        // Ensure folder exists
        const folder = this.app.vault.getAbstractFileByPath(this.settings.syncFolder);
        if (!folder) {
            await this.app.vault.createFolder(this.settings.syncFolder);
        }

        // Create or overwrite file
        const existingFile = this.app.vault.getAbstractFileByPath(filename);
        if (existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, fullContent);
        } else {
            await this.app.vault.create(filename, fullContent);
        }

        return filename;
    }

    // Dive Deeper on a training session - uses notes as context
    async diveDeepOnSession(view: MarkdownView) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const content = await this.app.vault.read(file);

        // Parse frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let topic = '';
        let fileType = '';
        let rlmSessionId = '';

        if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];
            const topicMatch = frontmatter.match(/topic:\s*"?\[\[([^\]]+)\]\]"?/) || frontmatter.match(/topic:\s*"([^"]+)"/);
            const typeMatch = frontmatter.match(/type:\s*(\S+)/);
            const rlmMatch = frontmatter.match(/rlm_session_id:\s*"([^"]+)"/);
            if (topicMatch) topic = topicMatch[1];
            if (typeMatch) fileType = typeMatch[1];
            if (rlmMatch) rlmSessionId = rlmMatch[1];
        }

        // Extract session notes and reflections
        const reflectionSections: string[] = [];

        // Find "What worked", "What to adjust", "Key insight" sections
        const whatWorkedMatch = content.match(/\*\*What worked:\*\*\s*\n([^\n*]+)/g);
        const whatToAdjustMatch = content.match(/\*\*What to adjust:\*\*\s*\n([^\n*]+)/g);
        const keyInsightMatch = content.match(/\*\*Key insight:\*\*\s*\n([^\n*]+)/g);

        if (whatWorkedMatch) {
            whatWorkedMatch.forEach(m => {
                const text = m.replace('**What worked:**', '').trim();
                if (text && text.length > 2) reflectionSections.push(`What worked: ${text}`);
            });
        }
        if (whatToAdjustMatch) {
            whatToAdjustMatch.forEach(m => {
                const text = m.replace('**What to adjust:**', '').trim();
                if (text && text.length > 2) reflectionSections.push(`Need to adjust: ${text}`);
            });
        }
        if (keyInsightMatch) {
            keyInsightMatch.forEach(m => {
                const text = m.replace('**Key insight:**', '').trim();
                if (text && text.length > 2) reflectionSections.push(`Key insight: ${text}`);
            });
        }

        // Also grab any notes section content
        const notesMatch = content.match(/## Notes\n([\s\S]*?)(?=\n##|$)/);
        if (notesMatch && notesMatch[1].trim().length > 10) {
            reflectionSections.push(`Notes: ${notesMatch[1].trim().substring(0, 500)}`);
        }

        if (!topic) {
            // Try to get topic from title
            const titleMatch = content.match(/# (?:Training Plan:|Research:)?\s*(.+)/);
            if (titleMatch) topic = titleMatch[1].trim();
        }

        if (!topic) {
            new Notice('Could not find topic in this file');
            return;
        }

        const sessionContext = reflectionSections.length > 0
            ? reflectionSections.join('\n')
            : 'Training session completed';

        // Open Dive Deeper modal with context and RLM session
        const modal = new DiveDeepModal(this.app, this, topic, sessionContext, rlmSessionId);
        modal.open();

        if (rlmSessionId) {
            new Notice('Deep Dive session loaded!', 2000);
        }
    }

    // Generate Training Review from Training Notes (coach side)
    async generateTrainingReview(view: MarkdownView) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const content = await this.app.vault.read(file);

        // Parse frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatterMatch) {
            new Notice('No frontmatter found. Is this a Training Notes file?');
            return;
        }

        const frontmatter = frontmatterMatch[1];

        // Check if this is a training-notes file
        const typeMatch = frontmatter.match(/type:\s*(\S+)/);
        if (!typeMatch || typeMatch[1] !== 'training-notes') {
            new Notice('This command only works on Training Notes files');
            return;
        }

        // Extract session_id for Oracle
        const sessionIdMatch = frontmatter.match(/session_id:\s*"([^"]+)"/);
        const sessionId = sessionIdMatch ? sessionIdMatch[1] : null;

        // Extract focus
        const focusMatch = frontmatter.match(/focus:\s*"([^"]+)"/);
        const focus = focusMatch ? focusMatch[1] : 'general';

        // Extract date
        const dateMatch = frontmatter.match(/date:\s*(\S+)/);
        const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

        // Extract season/episode
        const seasonMatch = frontmatter.match(/season:\s*(\d+)/);
        const episodeMatch = frontmatter.match(/episode:\s*(\d+)/);
        const season = seasonMatch ? parseInt(seasonMatch[1]) : this.settings.currentSeason;
        const episode = episodeMatch ? parseInt(episodeMatch[1]) : this.settings.currentEpisode;

        // Get the folder path from the current file
        const folderPath = file.parent?.path || `${this.settings.syncFolder}/Athletes/Unknown/Season ${season}/Session ${episode}`;

        // Build filenames
        const notesFilename = file.basename;
        const reviewFilename = notesFilename.replace('TrainingNotes', 'TrainingReview');

        // Extract struggles from content for the query
        const strugglesMatch = content.match(/## Struggles[\s\S]*?(?=##|$)/);
        const struggles = strugglesMatch ? strugglesMatch[0].replace('## Struggles', '').trim() : focus;

        new Notice('Generating Training Review...', 3000);

        try {
            // Call the coach-review endpoint with struggles as query
            const researchResponse = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/coach-review`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    query: struggles || focus,
                    session_context: `Training session: ${focus}`
                })
            });

            const research = researchResponse.json;

            // Extract research data
            const articleContent = research.article || research.article_raw || 'Research generation failed.';
            const topic = research.topic || focus;
            const rlmSessionId = research.rlm_session_id || '';
            const conversationUuid = research.conversation_uuid || '';
            const sourceCount = research.source_count || 0;

            // Create Training Review content
            const reviewContent = `---
type: training-review
season: ${season}
episode: ${episode}
date: ${dateStr}
focus: "${focus}"
topic: "${topic}"
training_notes: "[[${notesFilename}]]"
rlm_session_id: "${rlmSessionId}"
conversation_uuid: "${conversationUuid}"
source_count: ${sourceCount}
tags: [bjj, training-review, season-${season}, ${focus.replace(/_/g, '-')}]
---

# Training Review: ${topic}

${articleContent}

---
## Deep Dive
${rlmSessionId ? `> [!tip] Deep Dive Available
> Select text and right-click → "Dive Deeper" to explore specific topics.
> Or [View in Oracle](http://localhost:5002/c/${conversationUuid}) for the full interactive experience.` : '> No RLM session available for Deep Dive.'}

## Links
- Training Notes: [[${notesFilename}]]
${conversationUuid ? `- [View in Oracle](http://localhost:5002/c/${conversationUuid})` : ''}
`;

            // Save Training Review
            const reviewPath = `${folderPath}/${reviewFilename}.md`;
            const existingReview = this.app.vault.getAbstractFileByPath(reviewPath);
            if (existingReview instanceof TFile) {
                await this.app.vault.modify(existingReview, reviewContent);
            } else {
                await this.app.vault.create(reviewPath, reviewContent);
            }

            // Add backlink to source file for graph view
            await this.addTrainingReviewLink(file, reviewFilename);

            new Notice(`Training Review saved: ${reviewFilename}`, 5000);

            // Open the new Training Review file
            const reviewFile = this.app.vault.getAbstractFileByPath(reviewPath);
            if (reviewFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(reviewFile);
            }

        } catch (error) {
            console.error('Training review generation error:', error);
            new Notice('Failed to generate Training Review. Check console for details.', 5000);
        }
    }

    // Generate Training Review from selected text (right-click context menu)
    async generateTrainingReviewFromSelection(editor: Editor, view: MarkdownView, selection: string) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const query = selection.trim();
        if (!query) {
            new Notice('No text selected');
            return;
        }

        new Notice(`Generating Training Review...`, 3000);

        try {
            // Get context from current file
            const content = await this.app.vault.read(file);
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

            let sessionContext = '';
            let focus = 'research';
            let dateStr = new Date().toISOString().split('T')[0];
            let season = this.settings.currentSeason;
            let episode = this.settings.currentEpisode;
            let athleteName = this.settings.athleteName || 'Athlete';

            if (frontmatterMatch) {
                const frontmatter = frontmatterMatch[1];
                const focusMatch = frontmatter.match(/focus:\s*"([^"]+)"/);
                if (focusMatch) focus = focusMatch[1];

                const dateMatch = frontmatter.match(/date:\s*(\S+)/);
                if (dateMatch) dateStr = dateMatch[1];

                const seasonMatch = frontmatter.match(/season:\s*(\d+)/);
                if (seasonMatch) season = parseInt(seasonMatch[1]);

                const episodeMatch = frontmatter.match(/episode:\s*(\d+)/);
                if (episodeMatch) episode = parseInt(episodeMatch[1]);

                // Extract struggles for context
                const strugglesMatch = content.match(/## Struggles[\s\S]*?(?=##|$)/);
                if (strugglesMatch) {
                    sessionContext = strugglesMatch[0].replace('## Struggles', '').trim();
                }
            }

            // Call the coach-review endpoint with the selected query
            const researchResponse = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/coach-review`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    query: query,
                    athlete_name: athleteName,
                    session_context: sessionContext
                })
            });

            const research = researchResponse.json;

            // Extract research data
            // Use article_raw (no links) for markdown, Oracle URL for viewing with videos
            const articleContent = research.article_raw || research.article || 'Research generation failed.';
            const topic = research.topic || query;
            const rlmSessionId = research.rlm_session_id || '';
            const sourceCount = research.source_count || 0;
            const articleSections = research.article_sections || [];
            const conversationUuid = research.conversation_uuid || '';

            // Build Oracle URL - use /c/<uuid> if available (views existing article)
            // Falls back to ?q= search (regenerates article) if no conversation saved
            const oracleUrl = conversationUuid
                ? `http://localhost:5002/c/${conversationUuid}`
                : `http://localhost:5002/?q=${encodeURIComponent(topic)}`;

            // Build TTS audio section - now uses audio player modal
            let audioSection = '';
            if (articleSections.length > 0) {
                audioSection = `## Listen to Review\n`;
                audioSection += `> [!tip] Audio Player Available\n`;
                audioSection += `> **${articleSections.length} audio sections** ready to play.\n`;
                audioSection += `> Press \`Ctrl/Cmd + P\` and search "Open Audio Player" to listen.\n\n`;
            }

            // Create safe filename from query
            const safeQuery = query.substring(0, 40).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
            const reviewFilename = `TrainingReview-${dateStr}-${safeQuery}`;

            // Get folder path
            const folderPath = file.parent?.path || `${this.settings.syncFolder}/Athletes/${athleteName}/Season ${season}/Session ${episode}`;

            // Create Training Review content (draft status until published)
            // Store audio sections as YAML array for the player modal
            const audioSectionsYaml = articleSections.length > 0
                ? `audio_sections_data:\n${articleSections.map(s => `  - title: "${s.title.replace(/"/g, "'")}"\n    audio_url: "${s.audio_url}"`).join('\n')}`
                : 'audio_sections_data: []';

            const reviewContent = `---
type: training-review
status: draft
season: ${season}
episode: ${episode}
date: ${dateStr}
query: "${query.replace(/"/g, "'")}"
topic: "${topic.replace(/"/g, "'")}"
source_file: "[[${file.basename}]]"
rlm_session_id: "${rlmSessionId}"
conversation_uuid: "${conversationUuid}"
source_count: ${sourceCount}
audio_sections: ${articleSections.length}
${audioSectionsYaml}
pipeline: "${research.pipeline || 'multi_thinker'}"
thinkers_used: ${research.thinkers_used || 0}
tags: [bjj, training-review, season-${season}, research, draft]
---

# Training Review: ${topic}
> [!warning] DRAFT - Review and edit before publishing
> Use command "Flipmode: Publish Training Review" when ready to send to athlete.
> [View with Videos](${oracleUrl}) - Open in Oracle to verify sources

${audioSection}> **Query:** ${query}

${articleContent}

---
## Deep Dive
${rlmSessionId ? `> [!tip] Deep Dive Available
> Select text and right-click → "Dive Deeper" to explore specific topics.
> Or [View in Oracle](http://localhost:5002/c/${conversationUuid}) for the full interactive experience.` : '> No RLM session available for Deep Dive.'}

## Links
- Source: [[${file.basename}]]
${conversationUuid ? `- [View in Oracle](http://localhost:5002/c/${conversationUuid})` : ''}
`;

            // Save Training Review
            const reviewPath = `${folderPath}/${reviewFilename}.md`;
            const existingReview = this.app.vault.getAbstractFileByPath(reviewPath);
            if (existingReview instanceof TFile) {
                await this.app.vault.modify(existingReview, reviewContent);
            } else {
                await this.app.vault.create(reviewPath, reviewContent);
            }

            // Add backlink to source file for graph view
            await this.addTrainingReviewLink(file, reviewFilename);

            new Notice(`Training Review saved: ${reviewFilename}`, 5000);

            // Open the new Training Review file
            const reviewFile = this.app.vault.getAbstractFileByPath(reviewPath);
            if (reviewFile instanceof TFile) {
                await this.app.workspace.getLeaf('split').openFile(reviewFile);
            }

        } catch (error) {
            console.error('Training review from selection error:', error);
            new Notice('Failed to generate Training Review. Check console for details.', 5000);
        }
    }

    // Add backlink to source file for two-way graph connection
    async addTrainingReviewLink(sourceFile: TFile, reviewFilename: string) {
        try {
            const content = await this.app.vault.read(sourceFile);
            const reviewLink = `[[${reviewFilename}]]`;

            // Check if Training Reviews section exists
            if (content.includes('## Training Reviews')) {
                // Add to existing section if not already there
                if (!content.includes(reviewLink)) {
                    const updatedContent = content.replace(
                        /## Training Reviews\n/,
                        `## Training Reviews\n- ${reviewLink}\n`
                    );
                    await this.app.vault.modify(sourceFile, updatedContent);
                }
            } else {
                // Add new section at the end
                const updatedContent = content + `\n## Training Reviews\n- ${reviewLink}\n`;
                await this.app.vault.modify(sourceFile, updatedContent);
            }
        } catch (error) {
            console.error('Failed to add backlink:', error);
        }
    }

    // Dive Deeper - explore selected text using Oracle's RLM context
    async diveDeeper(editor: Editor, view: MarkdownView, selection: string) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const focusText = selection.trim();
        if (!focusText) {
            new Notice('No text selected');
            return;
        }

        // Read frontmatter to get session context
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
            new Notice('No frontmatter found. Dive Deeper requires a Training Review file.');
            return;
        }

        const frontmatter = frontmatterMatch[1];

        // Check for rlm_session_id
        const sessionIdMatch = frontmatter.match(/rlm_session_id:\s*"([^"]+)"/);
        if (!sessionIdMatch || !sessionIdMatch[1]) {
            new Notice('No RLM session found. Generate a Training Review first.');
            return;
        }

        const sessionId = sessionIdMatch[1];

        // Get conversation_uuid for syncing
        const convUuidMatch = frontmatter.match(/conversation_uuid:\s*"([^"]+)"/);
        const conversationUuid = convUuidMatch ? convUuidMatch[1] : null;

        new Notice(`Diving deeper on: ${focusText.substring(0, 40)}...`, 3000);

        try {
            // Call Oracle's internal Deep Dive endpoint
            const oracleUrl = 'http://localhost:5002';

            const response = await requestUrl({
                url: `${oracleUrl}/api/internal/deep-dive`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    focus_text: focusText,
                    conversation_uuid: conversationUuid
                })
            });

            const result = response.json;

            if (result.error) {
                new Notice(`Deep Dive failed: ${result.error}`, 5000);
                return;
            }

            const deepDiveContent = result.deep_dive_raw || result.deep_dive_html || 'Deep Dive generation failed.';
            const focusArea = result.focus_area || focusText.substring(0, 50);
            const newSourcesCount = result.new_sources_count || 0;

            // Append Deep Dive section to current file
            const timestamp = new Date().toLocaleTimeString();
            const deepDiveSection = `

---
## Deep Dive: ${focusArea}
*Generated at ${timestamp} | ${newSourcesCount} new sources*

${deepDiveContent}
`;

            // Append to file
            const updatedContent = content + deepDiveSection;
            await this.app.vault.modify(file, updatedContent);

            new Notice(`Deep Dive complete: ${focusArea} (${newSourcesCount} new sources)`, 5000);

            // Scroll to the new section
            const newCursor = { line: editor.lineCount() - 1, ch: 0 };
            editor.setCursor(newCursor);
            editor.scrollIntoView({ from: newCursor, to: newCursor }, true);

        } catch (error) {
            console.error('Deep Dive error:', error);
            new Notice('Deep Dive failed. Check console for details.', 5000);
        }
    }

    // Explode article content into linked concept graph nodes
    async explodeToConceptGraph(editor: Editor, view: MarkdownView, selection: string) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const contentToExplode = selection.trim();
        if (!contentToExplode || contentToExplode.length < 100) {
            new Notice('Select more text to explode (at least a paragraph)');
            return;
        }

        // Get source file's RLM session for concept enrichment later
        const sourceContent = await this.app.vault.read(file);
        const frontmatterMatch = sourceContent.match(/^---\n([\s\S]*?)\n---/);
        let sourceRlmSessionId = '';
        if (frontmatterMatch) {
            const sessionMatch = frontmatterMatch[1].match(/rlm_session_id:\s*"([^"]+)"/);
            if (sessionMatch) sourceRlmSessionId = sessionMatch[1];
        }

        new Notice('Exploding to concept graph...', 3000);

        try {
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/explode-concepts`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    content: contentToExplode,
                    source_file: file.basename
                })
            });

            const result = response.json;

            if (result.error) {
                new Notice(`Explode failed: ${result.error}`, 5000);
                return;
            }

            // Structure: checkpoints with invariables (tiered) and variables (IF/THEN)
            const checkpoints = result.checkpoints || [];
            if (checkpoints.length === 0) {
                new Notice('No checkpoints extracted');
                return;
            }

            const topicName = result.topic_name || file.basename;
            const topicTags: string[] = result.topic_tags || [];
            const clusterName = topicName.replace(/[^\w\s-]/g, '').trim();
            const conceptsBase = `${this.settings.syncFolder}/${this.settings.conceptsSubfolder}`;
            const conceptsFolder = `${conceptsBase}/${clusterName}`;
            await this.ensureFolder(conceptsFolder);

            const normalizeName = (name: string) => {
                if (!name) return '';
                let clean = name.replace(/[^\w\s-]/g, '').trim();
                clean = clean.replace(/^(The|A|An)\s+/i, '');
                return clean;
            };

            const topicTagsStr = topicTags.length > 0
                ? topicTags.map((t: string) => t.toLowerCase().replace(/\s+/g, '-')).join(', ')
                : '';

            let createdCount = 0;
            const createdNames = new Set<string>();
            checkpoints.sort((a: any, b: any) => (a.order || 1) - (b.order || 1));

            // Create CHECKPOINT notes (link sequentially)
            for (let i = 0; i < checkpoints.length; i++) {
                const cp = checkpoints[i];
                const cpName = normalizeName(cp.name);
                if (!cpName || createdNames.has(cpName.toLowerCase())) continue;

                const cpPath = `${conceptsFolder}/${cpName}.md`;
                if (this.app.vault.getAbstractFileByPath(cpPath)) {
                    createdNames.add(cpName.toLowerCase());
                    continue;
                }

                const order = cp.order || (i + 1);
                const prevCp = i > 0 ? normalizeName(checkpoints[i - 1].name) : null;
                const nextCp = i < checkpoints.length - 1 ? normalizeName(checkpoints[i + 1].name) : null;

                // Build invariables by tier
                const invariables = cp.invariables || [];
                const tier1 = invariables.filter((inv: any) => inv.tier === 'tier1');
                const tier2 = invariables.filter((inv: any) => inv.tier === 'tier2');
                const tier3 = invariables.filter((inv: any) => inv.tier === 'tier3' || !inv.tier);

                const formatTierLinks = (items: any[]) => items.length > 0
                    ? items.map((inv: any) => `[[${clusterName}/${normalizeName(inv.name)}|${normalizeName(inv.name)}]]`).join(' · ')
                    : '*none*';

                // Build variables
                const variables = cp.variables || [];
                const varLinks = variables.length > 0
                    ? variables.map((v: any) => `- **${v.trigger}** → [[${clusterName}/${normalizeName(v.name)}|${normalizeName(v.name)}]]`).join('\n')
                    : '*No situational responses*';

                const content = `---
type: checkpoint
order: ${order}
cluster: "${clusterName}"
tags: [grappling, checkpoint${topicTagsStr ? ', ' + topicTagsStr : ''}]
source_file: "${file.basename}"
source_rlm_session: "${sourceRlmSessionId}"
---

# [${order}] ${cpName}

> [!success] CHECKPOINT ${order} of ${checkpoints.length}

## Goal

${cp.goal || 'No goal defined.'}

## Success Test

> ${cp.success_test || 'No test defined.'}

---

## INVARIABLES (Always Do Together)

| Tier | Concepts |
|------|----------|
| CRITICAL | ${formatTierLinks(tier1)} |
| IMPORTANT | ${formatTierLinks(tier2)} |
| REFINEMENT | ${formatTierLinks(tier3)} |

---

## VARIABLES (IF/THEN)

${varLinks}

---

## Navigation

| Previous | Next |
|----------|------|
| ${prevCp ? `[[${clusterName}/${prevCp}|< ${prevCp}]]` : '*Start*'} | ${nextCp ? `[[${clusterName}/${nextCp}|${nextCp} >]]` : '*End*'} |
`;

                await this.app.vault.create(cpPath, content);
                createdNames.add(cpName.toLowerCase());
                createdCount++;
            }

            // Create INVARIABLE notes
            for (const cp of checkpoints) {
                const cpName = normalizeName(cp.name);
                const order = cp.order || 1;

                for (const inv of (cp.invariables || [])) {
                    const invName = normalizeName(inv.name);
                    if (!invName || createdNames.has(invName.toLowerCase())) continue;

                    const invPath = `${conceptsFolder}/${invName}.md`;
                    if (this.app.vault.getAbstractFileByPath(invPath)) {
                        createdNames.add(invName.toLowerCase());
                        continue;
                    }

                    const tier = inv.tier || 'tier3';
                    const tierLabel = tier === 'tier1' ? 'CRITICAL' : tier === 'tier2' ? 'IMPORTANT' : 'REFINEMENT';

                    // Siblings at same checkpoint
                    const siblings = (cp.invariables || [])
                        .filter((i: any) => normalizeName(i.name).toLowerCase() !== invName.toLowerCase())
                        .map((i: any) => `[[${clusterName}/${normalizeName(i.name)}|${normalizeName(i.name)}]]`)
                        .join(' · ');

                    const content = `---
type: invariable
tier: "${tier}"
checkpoint: "${cpName}"
checkpoint_order: ${order}
cluster: "${clusterName}"
tags: [grappling, invariable, ${tier}${topicTagsStr ? ', ' + topicTagsStr : ''}]
source_file: "${file.basename}"
source_rlm_session: "${sourceRlmSessionId}"
---

# ${invName}

> [!${tier === 'tier1' ? 'danger' : tier === 'tier2' ? 'warning' : 'info'}] ${tierLabel} INVARIABLE
> Part of [[${clusterName}/${cpName}|Checkpoint ${order}: ${cpName}]]

## WHY

> ${inv.why || 'See parent article.'}

## HOW

${inv.how || 'No explanation.'}

## FEEL

> ${inv.feel || 'No feel description.'}

---

## Do Together With

${siblings || '*Only invariable at this checkpoint*'}

## Parent

[[${clusterName}/${cpName}|< ${cpName}]]
`;

                    await this.app.vault.create(invPath, content);
                    createdNames.add(invName.toLowerCase());
                    createdCount++;
                }
            }

            // Create VARIABLE notes
            for (const cp of checkpoints) {
                const cpName = normalizeName(cp.name);
                const order = cp.order || 1;

                for (const v of (cp.variables || [])) {
                    const vName = normalizeName(v.name);
                    if (!vName || createdNames.has(vName.toLowerCase())) continue;

                    const vPath = `${conceptsFolder}/${vName}.md`;
                    if (this.app.vault.getAbstractFileByPath(vPath)) {
                        createdNames.add(vName.toLowerCase());
                        continue;
                    }

                    const content = `---
type: variable
trigger: "${v.trigger || ''}"
checkpoint: "${cpName}"
checkpoint_order: ${order}
cluster: "${clusterName}"
tags: [grappling, variable${topicTagsStr ? ', ' + topicTagsStr : ''}]
source_file: "${file.basename}"
source_rlm_session: "${sourceRlmSessionId}"
---

# ${vName}

> [!warning] VARIABLE - Situational Response
> Part of [[${clusterName}/${cpName}|Checkpoint ${order}: ${cpName}]]

## TRIGGER

> **${v.trigger || 'When opponent reacts'}**

## ACTION

${v.action || 'No action described.'}

## WHY This Works

> ${v.why || 'See parent article.'}

---

## Parent

[[${clusterName}/${cpName}|< ${cpName}]]
`;

                    await this.app.vault.create(vPath, content);
                    createdNames.add(vName.toLowerCase());
                    createdCount++;
                }
            }

            // Create index
            const clusterTag = `cluster/${clusterName.toLowerCase().replace(/\s+/g, '-')}`;
            const indexPath = `${conceptsBase}/${clusterName}.md`;

            const cpList = checkpoints.map((cp: any) => {
                const cpName = normalizeName(cp.name);
                const invCount = (cp.invariables || []).length;
                const varCount = (cp.variables || []).length;
                return `${cp.order || 1}. [[${clusterName}/${cpName}|${cpName}]] (${invCount} inv, ${varCount} var)`;
            }).join('\n');

            const totalInv = checkpoints.reduce((sum: number, cp: any) => sum + (cp.invariables || []).length, 0);
            const totalVar = checkpoints.reduce((sum: number, cp: any) => sum + (cp.variables || []).length, 0);

            // Build Mermaid flowchart
            let mermaidFlow = 'flowchart LR\n';
            for (let i = 0; i < checkpoints.length; i++) {
                const cp = checkpoints[i];
                const cpId = `CP${i + 1}`;
                const cpName = normalizeName(cp.name).replace(/"/g, '');
                mermaidFlow += `    ${cpId}["[${i + 1}] ${cpName}"]\n`;
            }
            for (let i = 0; i < checkpoints.length - 1; i++) {
                mermaidFlow += `    CP${i + 1} --> CP${i + 2}\n`;
            }

            const indexContent = `---
type: sequence
cluster: "${clusterName}"
tags: [cluster, grappling, sequence, ${clusterTag}]
source_file: "${file.basename}"
checkpoints_count: ${checkpoints.length}
invariables_count: ${totalInv}
variables_count: ${totalVar}
---

# ${clusterName}

> [!tip] Sequential Checkpoints with Invariables and Variables

**Source:** [[${file.basename}]]
**Checkpoints:** ${checkpoints.length} | **Invariables:** ${totalInv} | **Variables:** ${totalVar}

---

## Flow Diagram

\`\`\`mermaid
${mermaidFlow}\`\`\`

---

## The Sequence

${cpList}

---

## How It Works

1. **Checkpoints** = Sequential milestones (complete 1 before 2)
2. **Invariables** = Always do (tiered by priority, do together)
3. **Variables** = IF/THEN responses at each checkpoint
`;

            if (!this.app.vault.getAbstractFileByPath(indexPath)) {
                await this.app.vault.create(indexPath, indexContent);
            }

            // Create Canvas file for visual timeline
            const canvasPath = `${conceptsBase}/${clusterName}.canvas`;
            if (!this.app.vault.getAbstractFileByPath(canvasPath)) {
                const nodes: any[] = [];
                const edges: any[] = [];
                let nodeId = 1;

                // Layout constants
                const cpWidth = 280;
                const cpHeight = 80;
                const conceptWidth = 220;
                const conceptHeight = 60;
                const cpSpacing = 350;
                const verticalGap = 100;

                // Create checkpoint nodes (horizontal line)
                const cpNodeIds: string[] = [];
                for (let i = 0; i < checkpoints.length; i++) {
                    const cp = checkpoints[i];
                    const cpName = normalizeName(cp.name);
                    const cpId = `cp-${nodeId++}`;
                    cpNodeIds.push(cpId);

                    nodes.push({
                        id: cpId,
                        type: 'file',
                        file: `${conceptsFolder}/${cpName}.md`,
                        x: i * cpSpacing,
                        y: 0,
                        width: cpWidth,
                        height: cpHeight,
                        color: '6'
                    });

                    // Create invariable nodes below checkpoint
                    const invariables = cp.invariables || [];
                    for (let j = 0; j < invariables.length; j++) {
                        const inv = invariables[j];
                        const invName = normalizeName(inv.name);
                        const invId = `inv-${nodeId++}`;
                        const tier = inv.tier || 'tier3';
                        const color = tier === 'tier1' ? '1' : tier === 'tier2' ? '3' : '4';

                        nodes.push({
                            id: invId,
                            type: 'file',
                            file: `${conceptsFolder}/${invName}.md`,
                            x: i * cpSpacing + (j * 120) - ((invariables.length - 1) * 60),
                            y: cpHeight + verticalGap,
                            width: conceptWidth,
                            height: conceptHeight,
                            color: color
                        });

                        // Edge from checkpoint to invariable
                        edges.push({
                            id: `edge-${nodeId++}`,
                            fromNode: cpId,
                            toNode: invId,
                            fromSide: 'bottom',
                            toSide: 'top'
                        });
                    }

                    // Create variable nodes below invariables
                    const variables = cp.variables || [];
                    for (let k = 0; k < variables.length; k++) {
                        const v = variables[k];
                        const vName = normalizeName(v.name);
                        const vId = `var-${nodeId++}`;

                        nodes.push({
                            id: vId,
                            type: 'file',
                            file: `${conceptsFolder}/${vName}.md`,
                            x: i * cpSpacing + (k * 120) - ((variables.length - 1) * 60),
                            y: cpHeight + verticalGap * 2 + conceptHeight,
                            width: conceptWidth,
                            height: conceptHeight,
                            color: '2'
                        });

                        // Edge from checkpoint to variable
                        edges.push({
                            id: `edge-${nodeId++}`,
                            fromNode: cpId,
                            toNode: vId,
                            fromSide: 'bottom',
                            toSide: 'top'
                        });
                    }
                }

                // Create edges between checkpoints (the timeline)
                for (let i = 0; i < cpNodeIds.length - 1; i++) {
                    edges.push({
                        id: `edge-${nodeId++}`,
                        fromNode: cpNodeIds[i],
                        toNode: cpNodeIds[i + 1],
                        fromSide: 'right',
                        toSide: 'left'
                    });
                }

                const canvasContent = JSON.stringify({ nodes, edges }, null, 2);
                await this.app.vault.create(canvasPath, canvasContent);
            }

            new Notice(`Created "${clusterName}": ${checkpoints.length} checkpoints + Canvas timeline!`, 5000);

        } catch (error) {
            console.error('Explode to Concept Graph error:', error);
            new Notice('Failed to explode concepts. Check console.', 5000);
        }
    }

    // Get training drills and games for a concept node
    // Uses RLM deep dive to search video library, falls back to AI-generated suggestions
    async getTrainingDrillsForConcept(file: TFile) {
        // Read concept file
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
            new Notice('No frontmatter found. Is this a concept file?');
            return;
        }

        const frontmatter = frontmatterMatch[1];

        // Check if this is a concept file
        if (!frontmatter.includes('type: concept')) {
            new Notice('This command only works on concept files');
            return;
        }

        // Check if already has drills
        if (frontmatter.includes('has-drills')) {
            new Notice('This concept already has training drills');
            return;
        }

        // Extract concept info
        const conceptName = file.basename;
        const summaryMatch = content.match(/## Summary\n\n([^\n#]+)/);
        const conceptSummary = summaryMatch ? summaryMatch[1].trim() : conceptName;

        // Get source RLM session if available
        const sessionMatch = frontmatter.match(/source_rlm_session:\s*"([^"]+)"/);
        const rlmSessionId = sessionMatch ? sessionMatch[1] : '';

        new Notice(`Finding training drills for: ${conceptName}...`, 3000);

        try {
            // Call server endpoint to get training drills
            const response = await requestUrl({
                url: `${this.settings.serverUrl}/api/obsidian/concept-drills`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiToken}`
                },
                body: JSON.stringify({
                    concept_name: conceptName,
                    concept_summary: conceptSummary,
                    rlm_session_id: rlmSessionId
                })
            });

            const result = response.json;

            if (result.error) {
                new Notice(`Failed to get drills: ${result.error}`, 5000);
                return;
            }

            const drills = result.drills || result.content || 'No drills found.';
            const sourcesCount = result.sources_count || 0;
            const isGenerated = result.ai_generated || false;

            // Add has-drills tag to frontmatter
            const updatedFrontmatter = frontmatter.replace(
                /tags: \[([^\]]+)\]/,
                'tags: [$1, has-drills]'
            );

            // Build drills section
            const timestamp = new Date().toLocaleTimeString();
            const sourceNote = isGenerated
                ? '*(AI-generated suggestions)*'
                : `*(${sourcesCount} sources from video library)*`;

            const drillsSection = `

---
## Training Drills & Games
*Generated at ${timestamp}* ${sourceNote}

${drills}
`;

            // Update file with new frontmatter and drills section
            const updatedContent = content
                .replace(frontmatterMatch[0], `---\n${updatedFrontmatter}\n---`)
                + drillsSection;

            await this.app.vault.modify(file, updatedContent);

            const noticeText = isGenerated
                ? `Generated training suggestions for: ${conceptName}`
                : `Found ${sourcesCount} training drills for: ${conceptName}`;
            new Notice(noticeText, 5000);

        } catch (error) {
            console.error('Get Training Drills error:', error);
            new Notice('Failed to get training drills. Check console.', 5000);
        }
    }

    // Research a concept - dive deeper via Oracle RLM
    async researchConcept(file: TFile) {
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
            new Notice('No frontmatter found');
            return;
        }

        const frontmatter = frontmatterMatch[1];
        const conceptName = file.basename;

        // Get RLM session if available
        const sessionMatch = frontmatter.match(/source_rlm_session:\s*"([^"]+)"/);
        const rlmSessionId = sessionMatch ? sessionMatch[1] : '';

        new Notice(`Researching: ${conceptName}...`, 3000);

        try {
            // Query Oracle for more info about this concept
            const oracleUrl = 'http://localhost:5002';
            const response = await requestUrl({
                url: `${oracleUrl}/api/internal/deep-dive`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: rlmSessionId || `concept_${conceptName}`,
                    focus_text: `${conceptName}: key details, variations, common mistakes, and important nuances`
                })
            });

            const result = response.json;

            if (result.error) {
                new Notice(`Research failed: ${result.error}`, 5000);
                return;
            }

            const research = result.deep_dive_raw || result.deep_dive_html;
            const sourcesCount = result.new_sources_count || 0;

            if (!research || sourcesCount === 0) {
                new Notice(`No content found for "${conceptName}" in your library`, 5000);
                return;
            }

            // Append research to the concept file
            const timestamp = new Date().toLocaleTimeString();
            const researchSection = `

---
## Research Findings
*Found ${sourcesCount} sources at ${timestamp}*

${research}
`;

            const updatedContent = content + researchSection;
            await this.app.vault.modify(file, updatedContent);

            new Notice(`Added research for: ${conceptName} (${sourcesCount} sources)`, 5000);

        } catch (error) {
            console.error('Research concept error:', error);
            new Notice('Research failed. Is Oracle running?', 5000);
        }
    }

    // Generate Skill Development sessions from selected text (right-click context menu)
    // Creates 3 separate nodes: SkillDev1, SkillDev2, SkillDev3
    // Uses CLA (Constraints-Led Approach) science via Oracle's skill-dev endpoint
    async generateTrainingPlanFromSelection(editor: Editor, view: MarkdownView, selection: string) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const fullSelection = selection.trim();
        if (!fullSelection) {
            new Notice('No text selected');
            return;
        }

        // Extract short topic for filename/display (first line, max 60 chars)
        const firstLine = fullSelection.split('\n')[0].replace(/^#+\s*/, '').trim();
        const shortTopic = firstLine.substring(0, 60);

        // Read frontmatter to get RLM session context
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
            new Notice('No frontmatter found. Skill Development requires a Training Review file.');
            return;
        }

        const frontmatter = frontmatterMatch[1];

        // Check for rlm_session_id (required for CLA-based generation)
        const sessionIdMatch = frontmatter.match(/rlm_session_id:\s*"([^"]+)"/);
        if (!sessionIdMatch || !sessionIdMatch[1]) {
            new Notice('No RLM session found. Generate a Training Review first.');
            return;
        }

        const sessionId = sessionIdMatch[1];

        new Notice(`Generating CLA Skill Development for: ${shortTopic}...`, 5000);

        try {
            // Call Oracle's CLA-based skill development endpoint
            const oracleUrl = 'http://localhost:5002';

            const response = await requestUrl({
                url: `${oracleUrl}/api/internal/skill-dev`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    topic: fullSelection  // Send full selection for Oracle context
                })
            });

            const plan = response.json;

            if (plan.error) {
                new Notice(`Skill Development failed: ${plan.error}`, 5000);
                return;
            }

            if (!plan.sessions || plan.sessions.length === 0) {
                new Notice('Failed to generate skill development sessions');
                return;
            }

            // Create filenames for each session
            const dateStr = new Date().toISOString().split('T')[0];
            const safeTopic = shortTopic.substring(0, 25).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');

            // Get folder path (same location as source file or default)
            const folderPath = file.parent?.path || this.settings.syncFolder;

            // Ensure folder exists
            const folderExists = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folderExists) {
                await this.app.vault.createFolder(folderPath);
            }

            const createdFiles: string[] = [];

            // Create SkillDev files from CLA-generated sessions
            for (let i = 0; i < plan.sessions.length; i++) {
                const session = plan.sessions[i];
                const sessionNum = session.session_number || (i + 1);
                const filename = `SkillDev${sessionNum}-${dateStr}-${safeTopic}`;

                // Build CLA session markdown - use shortTopic for display
                const sessionMarkdown = this.buildCLASkillDevMarkdown(
                    shortTopic,
                    session,
                    file.basename,
                    createdFiles
                );

                // Save file
                const filePath = `${folderPath}/${filename}.md`;
                const existingFile = this.app.vault.getAbstractFileByPath(filePath);
                if (existingFile instanceof TFile) {
                    await this.app.vault.modify(existingFile, sessionMarkdown);
                } else {
                    await this.app.vault.create(filePath, sessionMarkdown);
                }

                createdFiles.push(filename);
            }

            // Add backlinks to source file
            await this.addSkillDevLinks(file, createdFiles);

            new Notice(`Created ${plan.sessions.length} CLA Skill Dev sessions for ${shortTopic}`, 5000);

            // Open the first SkillDev file
            const firstFile = this.app.vault.getAbstractFileByPath(`${folderPath}/${createdFiles[0]}.md`);
            if (firstFile instanceof TFile) {
                await this.app.workspace.getLeaf('split').openFile(firstFile);
            }

        } catch (error) {
            console.error('Skill development generation error:', error);
            new Notice('Failed to generate Skill Development. Check console for details.', 5000);
        }
    }

    // Build CLA-based skill development markdown from Oracle response
    buildCLASkillDevMarkdown(
        topic: string,
        session: any,  // CLA session from Oracle
        sourceFile: string,
        siblingFiles: string[]
    ): string {
        const dateStr = new Date().toISOString().split('T')[0];
        const cleanTopic = topic.replace(/"/g, "'");
        const sessionNum = session.session_number || 1;

        // Build linear navigation
        const prevFile = sessionNum > 1 ? siblingFiles[sessionNum - 2] : null;
        const nextFile = sessionNum < 3 ? siblingFiles[sessionNum] : null;

        // Only SkillDev1 links to source
        const sourceLink = sessionNum === 1 ? `\nsource: "[[${sourceFile}]]"` : '';
        const sourceLinkBody = sessionNum === 1 ? `- Source: [[${sourceFile}]]\n` : '';

        // Build rounds as simple bullets - use raw text from LLM
        let roundsList = '';
        if (session.rounds_text) {
            // Use raw rounds text from LLM (preferred - has reasoning)
            roundsList = session.rounds_text;
        } else if (session.rounds && session.rounds.length > 0) {
            for (const round of session.rounds) {
                const desc = round.description || round.start || 'Positional sparring';
                const reason = round.reasoning || round.because || '';
                roundsList += `- **Round ${round.round}:** ${desc}`;
                if (reason) roundsList += ` — ${reason}`;
                roundsList += '\n';
            }
        } else {
            roundsList = 'See source research for round details.\n';
        }

        // Build goals
        const goals = session.goals && session.goals.length > 0
            ? session.goals.map((g: string) => `- [ ] ${g}`).join('\n')
            : '- [ ] Complete all 5 rounds\n- [ ] Note what worked';

        return `---
type: skill-development
methodology: CLA
session: ${sessionNum}
topic: "${cleanTopic}"
date: ${dateStr}
resistance: "${session.resistance_level || '50%'}"
status: pending${sourceLink}
tags: [bjj, skill-dev, cla, session-${sessionNum}]
---

# SkillDev ${sessionNum}: ${session.title || 'Session ' + sessionNum}

**Resistance:** ${session.resistance_level || '50%'}
**Focus:** ${session.focus || 'Skill development'}

${prevFile ? `Previous: [[${prevFile}]]` : ''}${prevFile && nextFile ? ' | ' : ''}${nextFile ? `Next: [[${nextFile}]]` : ''}

## Positional Sparring Rounds

${roundsList}

## Goals

${goals}

## Post-Session Notes

**What worked:**


**What to adjust:**


**Key insight:**

---

${sourceLinkBody}
`;
    }

    // Add backlink to source file - ONLY links to SkillDev1 for linear chain
    // Graph structure: TrainingReview → SkillDev1 → SkillDev2 → SkillDev3
    async addSkillDevLinks(sourceFile: TFile, filenames: string[]) {
        try {
            const content = await this.app.vault.read(sourceFile);
            // Only link to first SkillDev - creates linear chain in graph
            const firstLink = `[[${filenames[0]}]]`;

            // Check if Skill Development section exists
            if (content.includes('## Skill Development')) {
                // Check if this link already exists
                if (!content.includes(filenames[0])) {
                    const updatedContent = content.replace(
                        /## Skill Development\n/,
                        `## Skill Development\n- ${firstLink}\n`
                    );
                    await this.app.vault.modify(sourceFile, updatedContent);
                }
            } else {
                // Add new section at the end
                const updatedContent = content + `\n## Skill Development\n- ${firstLink}\n`;
                await this.app.vault.modify(sourceFile, updatedContent);
            }
        } catch (error) {
            console.error('Failed to add skill dev backlinks:', error);
        }
    }

    // Publish Training Review to athlete
    async publishTrainingReview(view: MarkdownView) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const content = await this.app.vault.read(file);

        // Check frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatterMatch) {
            new Notice('No frontmatter found');
            return;
        }

        const frontmatter = frontmatterMatch[1];

        // Check if this is a training-review file
        const typeMatch = frontmatter.match(/type:\s*(\S+)/);
        if (!typeMatch || typeMatch[1] !== 'training-review') {
            new Notice('This command only works on Training Review files');
            return;
        }

        // Check if already published
        const statusMatch = frontmatter.match(/status:\s*(\S+)/);
        if (statusMatch && statusMatch[1] === 'published') {
            new Notice('This review is already published');
            return;
        }

        // Update status to published
        let updatedContent = content.replace(/status:\s*draft/, 'status: published');

        // Remove draft tag and add published tag
        updatedContent = updatedContent.replace(/tags:\s*\[(.*?)\]/, (match, tags) => {
            const tagList = tags.split(',').map((t: string) => t.trim()).filter((t: string) => t !== 'draft');
            tagList.push('published');
            return `tags: [${tagList.join(', ')}]`;
        });

        // Remove the draft warning callout
        updatedContent = updatedContent.replace(/> \[!warning\] DRAFT.*\n> Use command.*\n\n?/g, '');

        // Remove video links (Harvard citations with URLs) - keep citation text, remove links
        // Pattern: [Citation Text](http://...) -> Citation Text
        updatedContent = updatedContent.replace(/\[([^\]]+)\]\(http[^)]+\)/g, '$1');

        // Add published notice
        const publishDate = new Date().toISOString().split('T')[0];
        updatedContent = updatedContent.replace(
            /# Training Review:/,
            `> [!success] Published ${publishDate}\n\n# Training Review:`
        );

        // Save the updated file
        await this.app.vault.modify(file, updatedContent);

        new Notice('Training Review published to athlete!', 5000);
    }

    // Open Audio Player for Training Review files
    async openAudioPlayer(view: MarkdownView) {
        const file = view.file;
        if (!file) {
            new Notice('No file open');
            return;
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter;

        if (!frontmatter) {
            new Notice('No frontmatter found');
            return;
        }

        // Check if this file has audio sections
        const audioSectionsData = frontmatter.audio_sections_data;
        if (!audioSectionsData || audioSectionsData.length === 0) {
            new Notice('No audio sections found in this file');
            return;
        }

        // Get topic for the modal title
        const topic = frontmatter.topic || frontmatter.query || file.basename;
        const rlmSessionId = frontmatter.rlm_session_id || null;

        // Open the audio player modal
        const audioModal = new AudioPlayerModal(
            this.app,
            this,
            topic,
            audioSectionsData,
            rlmSessionId,
            '', // No article content needed - just playing audio
            []  // No sources needed
        );
        audioModal.open();
    }

    // Sync Methods
    async syncWithFlipmode() {
        const connected = await this.checkConnection();
        if (!connected) {
            new Notice('Cannot connect to Flipmode server');
            return;
        }

        new Notice('Syncing with Flipmode...');

        try {
            // Get sync manifest
            const userId = this.settings.apiToken.substring(0, 8) || 'default';
            const manifest = await this.apiRequest(`/sync/manifest/${userId}`);

            // Ensure directories exist
            await this.ensureFoldersExist(manifest.directories);

            // Sync each file
            let syncedCount = 0;
            for (const file of manifest.files) {
                const synced = await this.syncFile(file);
                if (synced) syncedCount++;
            }

            new Notice(`Synced ${syncedCount} files from Flipmode`);
        } catch (error) {
            console.error('Sync error:', error);
            new Notice('Sync failed - check console for details');
        }
    }

    // Sync shared concept from coach and open it (called from Discord link)
    async syncAndOpenConcept(conceptName: string) {
        new Notice(`Syncing "${conceptName}" from coach...`);

        try {
            // In remote mode, fetch from queue service
            if (this.settings.mode === 'remote' && this.settings.athleteToken) {
                const response = await requestUrl({
                    url: `${this.settings.queueServiceUrl}/api/queue/shared-concepts`,
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${this.settings.athleteToken}` }
                });

                const sharedConcepts = response.json.shared_concepts || [];

                // Find the specific concept
                const concept = sharedConcepts.find((c: any) =>
                    c.name === conceptName || c.name.includes(conceptName)
                );

                if (concept) {
                    // Save concept files to vault
                    const conceptsBase = `${this.settings.syncFolder}/${this.settings.conceptsSubfolder}`;
                    // Ensure base folder exists
                    await this.ensureFolder(conceptsBase);

                    const data = concept.data || {};

                    if (data.type === 'cluster' && data.clusterName) {
                        // Create cluster folder and files
                        const clusterFolder = `${conceptsBase}/${data.clusterName}`;
                        await this.ensureFolder(clusterFolder);

                        // Save index file
                        const indexPath = `${conceptsBase}/${data.clusterName}.md`;
                        if (data.indexContent) {
                            await this.saveNote(indexPath, data.indexContent);
                        }

                        // Save concept files
                        for (const c of data.concepts || []) {
                            const filePath = `${clusterFolder}/${c.name}.md`;
                            await this.saveNote(filePath, c.content);
                        }

                        new Notice(`Synced "${conceptName}" - opening...`);
                        await this.app.workspace.openLinkText(indexPath, '', true);
                    } else if (data.type === 'concept' && data.content) {
                        // Single concept with content
                        const filePath = `${conceptsBase}/${conceptName}.md`;
                        await this.saveNote(filePath, data.content);
                        new Notice(`Synced "${conceptName}" - opening...`);
                        await this.app.workspace.openLinkText(filePath, '', true);
                    } else {
                        // No full data - create stub note with summary
                        const filePath = `${conceptsBase}/${conceptName}.md`;
                        const stubContent = `---
type: shared-concept
from_oracle: true
shared_at: "${concept.shared_at || new Date().toISOString()}"
---

# ${conceptName}

${concept.summary || 'Concept shared from Oracle.'}

---
*Full content pending - sync with Oracle for details.*
`;
                        await this.saveNote(filePath, stubContent);
                        new Notice(`Synced "${conceptName}" - opening...`);
                        await this.app.workspace.openLinkText(filePath, '', true);
                    }
                    return;
                }
            }

            // Fallback: try to open existing file
            const filePath = `${this.settings.syncFolder}/${this.settings.conceptsSubfolder}/${conceptName}.md`;
            const file = this.app.vault.getAbstractFileByPath(filePath);

            if (file instanceof TFile) {
                await this.app.workspace.openLinkText(filePath, '', true);
                new Notice(`Opened "${conceptName}"`);
            } else {
                new Notice(`Concept "${conceptName}" not found. Sync with Oracle first.`);
            }
        } catch (error: any) {
            console.error('Sync and open error:', error);
            new Notice(`Failed to sync: ${error.message}`);
        }
    }

    async ensureFoldersExist(paths: string[]) {
        for (const path of paths) {
            const folder = this.app.vault.getAbstractFileByPath(path);
            if (!folder) {
                await this.app.vault.createFolder(path);
            }
        }
    }

    async syncFile(file: { path: string; content: string; checksum: string }): Promise<boolean> {
        try {
            const existingFile = this.app.vault.getAbstractFileByPath(file.path);

            if (existingFile instanceof TFile) {
                // Check if content changed
                const currentContent = await this.app.vault.read(existingFile);
                if (this.computeChecksum(currentContent) !== file.checksum) {
                    await this.app.vault.modify(existingFile, file.content);
                    return true;
                }
                return false;
            } else {
                // Create new file
                await this.app.vault.create(file.path, file.content);
                return true;
            }
        } catch (error) {
            console.error(`Error syncing file ${file.path}:`, error);
            return false;
        }
    }

    computeChecksum(content: string): string {
        // Simple checksum - in production use proper hash
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16).substring(0, 16);
    }

    startAutoSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }

        this.syncIntervalId = window.setInterval(
            () => this.syncWithFlipmode(),
            this.settings.syncInterval * 60 * 1000
        );
    }

    // UI Methods
    async showFlipmodeMenu() {
        new FlipmodeMenuModal(this.app, this).open();
    }

    async showResearchModal() {
        new ResearchModal(this.app, this).open();
    }

    async showVoiceNoteModal() {
        new VoiceNoteModal(this.app, this).open();
    }

    // Voice session method - Step 1: transcribe audio
    async startVoiceSession(audioBase64: string): Promise<any> {
        try {
            const response = await this.apiRequest('/session', 'POST', {
                user_id: this.settings.userId,
                audio_base64: audioBase64,
                audio_format: 'webm'
            });
            return response;
        } catch (error) {
            console.error('Voice session error:', error);
            throw error;
        }
    }

    // Voice session method - Step 2: confirm/edit transcript and process
    async confirmVoiceSession(confirmedText: string): Promise<any> {
        try {
            const response = await this.apiRequest('/session', 'POST', {
                user_id: this.settings.userId,
                confirmed_text: confirmedText
            });
            return response;
        } catch (error) {
            console.error('Confirm voice session error:', error);
            throw error;
        }
    }

    // Continue conversation - Step 1: send audio for transcription
    async respondToSession(sessionId: string, text?: string, audioBase64?: string, selectedOption?: string): Promise<any> {
        try {
            const body: any = {
                session_id: sessionId,
                user_id: this.settings.userId
            };

            if (audioBase64) {
                body.audio_base64 = audioBase64;
                body.audio_format = 'webm';
            } else if (text) {
                body.text = text;
            } else if (selectedOption) {
                body.selected_option = selectedOption;
            }

            const response = await this.apiRequest('/respond', 'POST', body);
            return response;
        } catch (error) {
            console.error('Respond error:', error);
            throw error;
        }
    }

    // Continue conversation - Step 2: confirm transcript and process
    async confirmRespondToSession(sessionId: string, confirmedText: string): Promise<any> {
        try {
            const response = await this.apiRequest('/respond', 'POST', {
                session_id: sessionId,
                user_id: this.settings.userId,
                confirmed_text: confirmedText
            });
            return response;
        } catch (error) {
            console.error('Confirm respond error:', error);
            throw error;
        }
    }

    async saveSessionToVault(session: any) {
        try {
            const date = new Date().toISOString().split('T')[0];
            const folder = this.settings.syncFolder + '/Sessions';
            await this.ensureFoldersExist([folder]);

            // Build markdown content
            let content = `---
type: training-session
date: ${date}
session_id: ${session.session_id}
tags: [bjj, training, voice-note]
---

# Training Session - ${date}

## Your Notes (Transcribed)

${session.transcript}

## Topics Identified

`;
            // Add topics
            if (session.extracted_topics) {
                const topics = session.extracted_topics;
                if (topics.work_on?.length) {
                    content += `### Work On\n`;
                    for (const t of topics.work_on) {
                        content += `- **${t.topic}**: ${t.context || ''}\n`;
                    }
                    content += '\n';
                }
                if (topics.wins?.length) {
                    content += `### Wins\n`;
                    for (const t of topics.wins) {
                        content += `- **${t.topic}**: ${t.context || ''}\n`;
                    }
                    content += '\n';
                }
            }

            content += `## Coach Response

${session.response_text}

`;
            // Add options if present
            if (session.options?.length) {
                content += `## Next Steps\n\n`;
                for (const opt of session.options) {
                    content += `- [ ] ${opt.label}\n`;
                }
            }

            const filename = `${folder}/${date}-${session.session_id.substring(0, 8)}.md`;

            const existingFile = this.app.vault.getAbstractFileByPath(filename);
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, content);
            } else {
                await this.app.vault.create(filename, content);
            }

            // Open the file
            const file = this.app.vault.getAbstractFileByPath(filename);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(file);
            }

            return filename;
        } catch (error) {
            console.error('Error saving session:', error);
            throw error;
        }
    }

    insertTrainingTemplate(editor: Editor) {
        const date = new Date().toISOString().split('T')[0];
        const template = `---
type: training-note
date: ${date}
tags: [bjj, training]
---

# Training Notes - ${date}

## What Worked Well


## What Needs Work


## Techniques Practiced


## Questions for Flipmode

`;
        editor.replaceSelection(template);
    }

    // Research method
    async research(topic: string, context: string = ''): Promise<any> {
        try {
            const response = await this.apiRequest('/research', 'POST', {
                topic,
                context,
                max_sources: 10
            });

            return response;
        } catch (error) {
            console.error('Research error:', error);
            throw error;
        }
    }

    async saveResearchToVault(topic: string, research: any) {
        try {
            // Get markdown from sync endpoint
            const mdResponse = await this.apiRequest('/sync/research', 'POST', {
                topic,
                article: research.article,
                sources: research.sources,
                context: research.context
            });

            // Ensure folder exists
            const folder = this.settings.syncFolder + '/Research';
            await this.ensureFoldersExist([folder]);

            // Save file
            await this.syncFile({
                path: mdResponse.path,
                content: mdResponse.content,
                checksum: mdResponse.checksum
            });

            // Open the file
            const file = this.app.vault.getAbstractFileByPath(mdResponse.path);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(file);
            }

            return mdResponse.path;
        } catch (error) {
            console.error('Error saving research:', error);
            throw error;
        }
    }
}

// Flipmode Menu Modal
class FlipmodeMenuModal extends Modal {
    plugin: BJJFlipmodePlugin;

    constructor(app: App, plugin: BJJFlipmodePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flipmode-modal');

        contentEl.createEl('h2', { text: 'Flipmode' });

        // Connection status
        const statusEl = contentEl.createEl('p', {
            text: 'Checking connection...',
            cls: 'flipmode-status'
        });

        this.plugin.checkConnection().then(connected => {
            statusEl.setText(connected ? 'Connected to Flipmode' : 'Not connected');
            statusEl.addClass(connected ? 'connected' : 'disconnected');
        });

        // Menu buttons
        const buttonContainer = contentEl.createDiv({ cls: 'flipmode-buttons' });

        new Setting(buttonContainer)
            .setName('Research Technique')
            .setDesc('Search the Flipmode for technique information')
            .addButton(btn => btn
                .setButtonText('Research')
                .setCta()
                .onClick(() => {
                    this.close();
                    this.plugin.showResearchModal();
                }));

        new Setting(buttonContainer)
            .setName('Sync with Flipmode')
            .setDesc('Download latest sessions and notes')
            .addButton(btn => btn
                .setButtonText('Sync')
                .onClick(() => {
                    this.close();
                    this.plugin.syncWithFlipmode();
                }));

        new Setting(buttonContainer)
            .setName('Settings')
            .setDesc('Configure Flipmode connection')
            .addButton(btn => btn
                .setButtonText('Open Settings')
                .onClick(() => {
                    this.close();
                    // @ts-ignore
                    this.app.setting.open();
                    // @ts-ignore
                    this.app.setting.openTabById('flipmode');
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Research Modal
class ResearchModal extends Modal {
    plugin: BJJFlipmodePlugin;
    topicInput: HTMLInputElement;
    contextInput: HTMLTextAreaElement;
    resultEl: HTMLElement;

    constructor(app: App, plugin: BJJFlipmodePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flipmode-research-modal');

        contentEl.createEl('h2', { text: 'Research a Technique' });

        // Topic input
        new Setting(contentEl)
            .setName('Technique')
            .setDesc('What technique do you want to research?')
            .addText(text => {
                this.topicInput = text.inputEl;
                text.setPlaceholder('e.g., knee slice pass, arm drag, berimbolo');
            });

        // Context input
        new Setting(contentEl)
            .setName('Context (optional)')
            .setDesc('Any specific situation or problem?')
            .addTextArea(text => {
                this.contextInput = text.inputEl;
                text.setPlaceholder('e.g., defending against it, from closed guard, against bigger opponents');
            });

        // Search button
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Search Flipmode')
                .setCta()
                .onClick(() => this.doResearch()));

        // Results area
        this.resultEl = contentEl.createDiv({ cls: 'flipmode-results' });
    }

    async doResearch() {
        const topic = this.topicInput.value.trim();
        if (!topic) {
            new Notice('Please enter a technique to research');
            return;
        }

        this.resultEl.empty();
        this.resultEl.createEl('p', { text: 'Searching Flipmode...' });

        try {
            const research = await this.plugin.research(topic, this.contextInput.value);

            this.resultEl.empty();

            if (research.source_count > 0) {
                this.resultEl.createEl('h3', {
                    text: `Found ${research.source_count} sources`
                });

                // Preview
                const previewEl = this.resultEl.createEl('div', { cls: 'research-preview' });
                previewEl.createEl('p', {
                    text: research.article.substring(0, 300) + '...'
                });

                // Sources list
                const sourcesList = this.resultEl.createEl('ul', { cls: 'sources-list' });
                for (const source of research.sources.slice(0, 5)) {
                    sourcesList.createEl('li', {
                        text: `${source.instructor} - ${source.title}`
                    });
                }

                // Save button
                new Setting(this.resultEl)
                    .addButton(btn => btn
                        .setButtonText('Save to Vault')
                        .setCta()
                        .onClick(async () => {
                            try {
                                const path = await this.plugin.saveResearchToVault(topic, research);
                                new Notice(`Saved to ${path}`);
                                this.close();
                            } catch (error) {
                                new Notice('Failed to save research');
                            }
                        }));
            } else {
                this.resultEl.createEl('p', {
                    text: 'No sources found. Try a different search term.'
                });
            }
        } catch (error) {
            this.resultEl.empty();
            this.resultEl.createEl('p', {
                text: 'Research failed. Check your connection settings.',
                cls: 'error'
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Voice Note Modal - Record training notes
class VoiceNoteModal extends Modal {
    plugin: BJJFlipmodePlugin;
    mediaRecorder: MediaRecorder | null = null;
    audioChunks: Blob[] = [];
    isRecording: boolean = false;
    recordBtn: HTMLButtonElement;
    statusEl: HTMLElement;
    resultEl: HTMLElement;
    timerEl: HTMLElement;
    timerInterval: number | null = null;
    recordingStartTime: number = 0;
    currentSessionId: string | null = null;  // Track current session for continuations

    constructor(app: App, plugin: BJJFlipmodePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flipmode-voice-modal');

        // Header - embedded base64 image (bulletproof)
        const headerContainer = contentEl.createDiv({ cls: 'flipmode-header' });
        headerContainer.style.textAlign = 'center';
        headerContainer.style.margin = '0 0 15px 0';

        const headerImg = headerContainer.createEl('img');
        headerImg.src = FLIPMODE_HEADER_BASE64;
        headerImg.alt = 'FLIPMODE';
        headerImg.style.maxWidth = '100%';
        headerImg.style.height = 'auto';

        // Timer display
        this.timerEl = contentEl.createEl('div', {
            text: '00:00',
            cls: 'voice-timer'
        });
        this.timerEl.style.fontSize = '2em';
        this.timerEl.style.textAlign = 'center';
        this.timerEl.style.margin = '20px 0';
        this.timerEl.style.fontFamily = 'monospace';

        // Status
        this.statusEl = contentEl.createEl('p', {
            text: 'Click to start recording',
            cls: 'voice-status'
        });
        this.statusEl.style.textAlign = 'center';
        this.statusEl.style.color = 'var(--text-muted)';

        // Results area (responses appear here, above the button)
        this.resultEl = contentEl.createDiv({ cls: 'voice-results' });

        // Record button (at the bottom)
        const btnContainer = contentEl.createDiv({ cls: 'voice-btn-container' });
        btnContainer.style.textAlign = 'center';
        btnContainer.style.marginTop = '20px';

        this.recordBtn = btnContainer.createEl('button', {
            text: 'START RECORDING'
        });
        this.recordBtn.style.cssText = `
            font-size: 16px;
            font-weight: 600;
            padding: 16px 32px;
            min-width: 200px;
            border: none;
            border-radius: 8px;
            background: var(--interactive-accent);
            color: var(--text-on-accent);
            cursor: pointer;
            transition: background 0.2s;
            text-align: center;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        `;
        this.recordBtn.onclick = () => this.toggleRecording();
    }

    async toggleRecording() {
        if (this.isRecording) {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            this.audioChunks = [];
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = () => {
                stream.getTracks().forEach(track => track.stop());
                this.processRecording();
            };

            this.mediaRecorder.start(1000); // Collect data every second
            this.isRecording = true;
            this.recordingStartTime = Date.now();

            this.recordBtn.setText('STOP');
            this.recordBtn.style.background = 'var(--text-error)';
            this.statusEl.setText('Recording... speak now');
            this.statusEl.style.color = 'var(--text-error)';

            // Start timer
            this.timerInterval = window.setInterval(() => {
                const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
                const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const secs = (elapsed % 60).toString().padStart(2, '0');
                this.timerEl.setText(`${mins}:${secs}`);
            }, 1000);

        } catch (error) {
            console.error('Recording error:', error);
            new Notice('Could not access microphone. Please allow microphone access.');
            this.statusEl.setText('Microphone access denied');
        }
    }

    async stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;

            if (this.timerInterval) {
                window.clearInterval(this.timerInterval);
                this.timerInterval = null;
            }

            this.recordBtn.setText('PROCESSING...');
            this.recordBtn.disabled = true;
            this.recordBtn.style.background = 'var(--text-muted)';
            this.statusEl.setText('Processing your voice note...');
            this.statusEl.style.color = 'var(--text-accent)';
        }
    }

    async processRecording() {
        try {
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });

            // Check if we're in remote (athlete) mode
            if (this.plugin.settings.mode === 'remote' && this.plugin.settings.athleteToken) {
                // REMOTE MODE: Use Heroku transcription
                this.statusEl.setText('Transcribing via cloud (2min max, 5/day)...');

                try {
                    const result = await this.plugin.remoteTranscribe(audioBlob);

                    // Show usage info
                    const usageInfo = `(${result.usage.remaining} voice notes remaining today)`;
                    this.statusEl.setText(`Transcribed ${Math.round(result.duration)}s ${usageInfo}`);

                    // Show transcript for confirmation before submitting to queue
                    this.showRemoteTranscriptConfirmation(result.text, result.usage);

                } catch (error: any) {
                    if (error.message.includes('Daily limit')) {
                        this.statusEl.setText('Daily voice note limit reached (5/day)');
                        new Notice('You have used all 5 voice notes for today. Try again tomorrow!');
                    } else if (error.message.includes('too long')) {
                        this.statusEl.setText('Recording too long (max 2 minutes)');
                        new Notice('Voice notes are limited to 2 minutes. Please record a shorter message.');
                    } else {
                        throw error;
                    }
                    this.recordBtn.setText('TRY AGAIN');
                    this.recordBtn.disabled = false;
                    this.recordBtn.style.background = 'var(--interactive-accent)';
                    return;
                }

            } else {
                // LOCAL MODE: Use local server transcription
                const base64 = await this.blobToBase64(audioBlob);
                this.statusEl.setText('Transcribing...');

                let response;
                if (this.currentSessionId) {
                    // CONTINUE existing session
                    response = await this.plugin.respondToSession(
                        this.currentSessionId,
                        undefined,
                        base64,
                        undefined
                    );

                    if (response.awaiting_confirmation) {
                        this.showTranscriptConfirmation(response.transcript, response.message, this.currentSessionId);
                    } else {
                        this.displayResults(response);
                    }
                } else {
                    // START new session
                    response = await this.plugin.startVoiceSession(base64);

                    if (response.awaiting_confirmation) {
                        this.showTranscriptConfirmation(response.transcript, response.message, null);
                    } else {
                        this.displayResults(response);
                    }
                }
            }

        } catch (error: any) {
            console.error('Processing error:', error);
            this.statusEl.setText('Error processing recording');
            this.statusEl.style.color = 'var(--text-error)';
            this.recordBtn.setText('TRY AGAIN');
            this.recordBtn.disabled = false;
            this.recordBtn.style.background = 'var(--interactive-accent)';

            this.resultEl.empty();
            this.resultEl.createEl('p', {
                text: `Error: ${error.message || 'Could not process recording'}`,
                cls: 'error'
            });
        }
    }

    // Track remote therapy session
    remoteTherapySessionId: string | null = null;

    // Show transcript confirmation for remote (athlete) mode - starts therapy session
    async showRemoteTranscriptConfirmation(transcript: string, usage: any) {
        this.resultEl.empty();

        this.statusEl.setText('Starting therapy session...');
        this.statusEl.style.color = 'var(--text-accent)';

        // Usage info
        const usageEl = this.resultEl.createEl('p', {
            text: `Voice notes today: ${usage.count}/${usage.limit} (${usage.remaining} remaining)`
        });
        usageEl.style.textAlign = 'center';
        usageEl.style.color = 'var(--text-muted)';
        usageEl.style.fontSize = '0.85em';
        usageEl.style.marginBottom = '10px';

        try {
            // Start therapy session with transcript
            const therapyResult = await this.plugin.startRemoteTherapy(transcript);

            if (therapyResult.state === 'ready') {
                // Already have enough info - show enriched query
                this.showEnrichedQueryConfirmation(therapyResult.enriched_query, transcript);
            } else {
                // Need more info - show question
                this.remoteTherapySessionId = therapyResult.session_id;
                this.showTherapyQuestion(therapyResult.question, transcript);
            }
        } catch (error: any) {
            console.error('Therapy start error:', error);
            // Fall back to direct submit
            this.showDirectSubmitForm(transcript, usage);
        }
    }

    // Show therapy question and let athlete respond
    showTherapyQuestion(question: string, originalTranscript: string) {
        this.resultEl.empty();

        this.statusEl.setText('Clarifying your training...');
        this.statusEl.style.color = 'var(--text-accent)';

        // Show original transcript (smaller)
        const origEl = this.resultEl.createEl('p', {
            text: `"${originalTranscript.substring(0, 100)}${originalTranscript.length > 100 ? '...' : ''}"`
        });
        origEl.style.cssText = 'font-style: italic; color: var(--text-muted); font-size: 0.9em; margin-bottom: 15px;';

        // Show question from therapy
        const questionEl = this.resultEl.createEl('p', { text: question });
        questionEl.style.cssText = 'font-weight: 500; margin-bottom: 15px; line-height: 1.5;';

        // Text input for answer
        const textarea = this.resultEl.createEl('textarea');
        textarea.placeholder = 'Type your answer...';
        textarea.style.cssText = `
            width: 100%;
            min-height: 80px;
            padding: 10px;
            border-radius: 8px;
            border: 1px solid var(--background-modifier-border);
            background: var(--background-primary);
            color: var(--text-normal);
            font-size: 14px;
            resize: vertical;
            margin-bottom: 15px;
        `;

        // Buttons
        const btnContainer = this.resultEl.createDiv();
        btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

        const answerBtn = btnContainer.createEl('button', { text: 'Answer' });
        answerBtn.style.cssText = `
            padding: 10px 20px;
            background: var(--interactive-accent);
            color: var(--text-on-accent);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
        `;
        answerBtn.onclick = async () => {
            const answer = textarea.value.trim();
            if (!answer) {
                new Notice('Please type an answer');
                return;
            }

            answerBtn.disabled = true;
            answerBtn.setText('Processing...');

            try {
                const result = await this.plugin.respondToRemoteTherapy(
                    this.remoteTherapySessionId!,
                    answer
                );

                if (result.state === 'ready') {
                    // Got enough info - show enriched query
                    this.showEnrichedQueryConfirmation(result.enriched_query, originalTranscript);
                } else {
                    // Need more info - show next question
                    this.showTherapyQuestion(result.question, originalTranscript);
                }
            } catch (error: any) {
                new Notice(`Error: ${error.message}`);
                answerBtn.disabled = false;
                answerBtn.setText('Answer');
            }
        };

        const skipBtn = btnContainer.createEl('button', { text: 'Skip & Submit' });
        skipBtn.style.cssText = `
            padding: 10px 20px;
            background: var(--background-modifier-border);
            color: var(--text-normal);
            border: none;
            border-radius: 6px;
            cursor: pointer;
        `;
        skipBtn.onclick = () => {
            // Submit original transcript directly
            this.showEnrichedQueryConfirmation(originalTranscript, originalTranscript);
        };

        // Update record button to allow voice answer
        this.recordBtn.setText('VOICE ANSWER');
        this.recordBtn.disabled = false;
        this.recordBtn.style.background = 'var(--interactive-accent)';
    }

    // Show enriched query for final confirmation before submitting
    showEnrichedQueryConfirmation(enrichedQuery: string, originalTranscript: string) {
        this.resultEl.empty();

        this.statusEl.setText('Ready to submit to analyst');
        this.statusEl.style.color = 'var(--text-success)';

        // Show what will be submitted
        const labelEl = this.resultEl.createEl('p', { text: 'Your research query:' });
        labelEl.style.cssText = 'font-weight: 500; margin-bottom: 10px;';

        const textarea = this.resultEl.createEl('textarea');
        textarea.value = enrichedQuery;
        textarea.style.cssText = `
            width: 100%;
            min-height: 80px;
            padding: 10px;
            border-radius: 8px;
            border: 1px solid var(--background-modifier-border);
            background: var(--background-primary);
            color: var(--text-normal);
            font-size: 14px;
            resize: vertical;
            margin-bottom: 15px;
        `;

        // Buttons
        const btnContainer = this.resultEl.createDiv();
        btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

        const submitBtn = btnContainer.createEl('button', { text: 'Submit to Analyst' });
        submitBtn.style.cssText = `
            padding: 10px 20px;
            background: var(--interactive-accent);
            color: var(--text-on-accent);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
        `;
        submitBtn.onclick = async () => {
            const finalQuery = textarea.value.trim();
            if (!finalQuery) {
                new Notice('Please enter a query');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.setText('Submitting...');

            try {
                // Submit enriched query to coach queue
                await this.plugin.queueClient?.submitQuery(finalQuery, {
                    original_transcript: originalTranscript,
                    therapy_session_id: this.remoteTherapySessionId
                });
                new Notice('Query submitted to analyst!');

                // Save to vault
                await this.saveRemoteVoiceNote(originalTranscript + '\n\n---\n\n**Research Query:** ' + finalQuery);

                this.statusEl.setText('Submitted! Your analyst will process this.');
                this.statusEl.style.color = 'var(--text-success)';

                this.recordBtn.setText('RECORD ANOTHER');
                this.recordBtn.disabled = false;
                this.recordBtn.style.background = 'var(--interactive-accent)';
                this.remoteTherapySessionId = null;

            } catch (error: any) {
                new Notice(`Submit failed: ${error.message}`);
                submitBtn.disabled = false;
                submitBtn.setText('Submit to Analyst');
            }
        };

        const saveOnlyBtn = btnContainer.createEl('button', { text: 'Save Only' });
        saveOnlyBtn.style.cssText = `
            padding: 10px 20px;
            background: var(--background-modifier-border);
            color: var(--text-normal);
            border: none;
            border-radius: 6px;
            cursor: pointer;
        `;
        saveOnlyBtn.onclick = async () => {
            await this.saveRemoteVoiceNote(originalTranscript + '\n\n---\n\n**Research Query:** ' + textarea.value);
            new Notice('Voice note saved to vault');
            this.close();
        };

        this.recordBtn.setText('RECORD NEW');
        this.recordBtn.disabled = false;
        this.recordBtn.style.background = 'var(--interactive-accent)';
    }

    // Fallback: direct submit form (if therapy fails)
    showDirectSubmitForm(transcript: string, usage: any) {
        this.resultEl.empty();

        this.statusEl.setText('Review your transcription');
        this.statusEl.style.color = 'var(--text-accent)';

        const textarea = this.resultEl.createEl('textarea');
        textarea.value = transcript;
        textarea.style.cssText = `
            width: 100%;
            min-height: 100px;
            padding: 10px;
            border-radius: 8px;
            border: 1px solid var(--background-modifier-border);
            background: var(--background-primary);
            color: var(--text-normal);
            font-size: 14px;
            resize: vertical;
            margin-bottom: 15px;
        `;

        const btnContainer = this.resultEl.createDiv();
        btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

        const submitBtn = btnContainer.createEl('button', { text: 'Submit to Analyst' });
        submitBtn.style.cssText = `
            padding: 10px 20px;
            background: var(--interactive-accent);
            color: var(--text-on-accent);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
        `;
        submitBtn.onclick = async () => {
            const finalText = textarea.value.trim();
            if (!finalText) {
                new Notice('Please enter some text');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.setText('Submitting...');

            try {
                await this.plugin.queueClient?.submitQuery(finalText);
                new Notice('Query submitted to analyst!');
                await this.saveRemoteVoiceNote(finalText);

                this.statusEl.setText('Submitted! Your analyst will process this.');
                this.statusEl.style.color = 'var(--text-success)';

                this.recordBtn.setText('RECORD ANOTHER');
                this.recordBtn.disabled = false;
                this.recordBtn.style.background = 'var(--interactive-accent)';
            } catch (error: any) {
                new Notice(`Submit failed: ${error.message}`);
                submitBtn.disabled = false;
                submitBtn.setText('Submit to Analyst');
            }
        };

        this.recordBtn.setText('RECORD MORE');
        this.recordBtn.disabled = false;
        this.recordBtn.style.background = 'var(--interactive-accent)';
    }

    // Save voice note to vault (for remote mode)
    async saveRemoteVoiceNote(transcript: string) {
        const date = new Date().toISOString().split('T')[0];
        const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
        const folder = this.plugin.settings.syncFolder + '/VoiceNotes';

        await this.plugin.ensureFoldersExist([folder]);

        const content = `---
type: voice-note
date: ${date}
tags: [bjj, voice-note]
---

# Voice Note - ${date} ${time}

${transcript}
`;

        const fileName = `${folder}/Voice Note ${date} ${time}.md`;
        await this.app.vault.create(fileName, content);
    }

    showTranscriptConfirmation(transcript: string, message: string, sessionIdForContinuation: string | null) {
        this.resultEl.empty();

        // Track whether this is a continuation or new session
        const isContinuation = sessionIdForContinuation !== null;

        this.statusEl.setText('Review your transcription');
        this.statusEl.style.color = 'var(--text-accent)';

        // Message explaining what to do
        const messageEl = this.resultEl.createEl('p', {
            text: message || 'Is this transcription correct? Edit if needed, then confirm.'
        });
        messageEl.style.textAlign = 'center';
        messageEl.style.color = 'var(--text-muted)';
        messageEl.style.marginBottom = '15px';

        // Editable transcript textarea
        const textareaContainer = this.resultEl.createDiv({ cls: 'transcript-edit-container' });
        textareaContainer.style.marginBottom = '20px';

        const textarea = textareaContainer.createEl('textarea', {
            cls: 'transcript-textarea'
        });
        textarea.value = transcript;
        textarea.style.cssText = `
            width: 100%;
            min-height: 120px;
            padding: 12px;
            font-size: 14px;
            line-height: 1.5;
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            background: var(--background-primary);
            color: var(--text-normal);
            resize: vertical;
            font-family: inherit;
        `;

        // Button container
        const btnContainer = this.resultEl.createDiv({ cls: 'confirm-btn-container' });
        btnContainer.style.textAlign = 'center';
        btnContainer.style.display = 'flex';
        btnContainer.style.gap = '10px';
        btnContainer.style.justifyContent = 'center';

        // Re-record button (secondary)
        const reRecordBtn = btnContainer.createEl('button', {
            text: '🎤 Re-record'
        });
        reRecordBtn.style.cssText = `
            font-size: 14px;
            padding: 12px 24px;
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            background: var(--background-secondary);
            color: var(--text-normal);
            cursor: pointer;
        `;
        reRecordBtn.onclick = () => {
            // Reset recording state
            this.isRecording = false;
            this.audioChunks = [];
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }

            // Reset UI and allow re-recording (keep session context for continuations)
            this.resultEl.empty();
            this.statusEl.setText(isContinuation ? 'Record your answer' : 'Click to start recording');
            this.statusEl.style.color = 'var(--text-muted)';
            this.recordBtn.setText(isContinuation ? 'ANSWER' : 'START RECORDING');
            this.recordBtn.disabled = false;
            this.recordBtn.style.display = 'inline-block';
            this.recordBtn.style.background = 'var(--interactive-accent)';
            this.timerEl.setText('00:00');
        };

        // Confirm button (primary)
        const confirmBtn = btnContainer.createEl('button', {
            text: '✓ Confirm & Process'
        });
        confirmBtn.style.cssText = `
            font-size: 14px;
            font-weight: 600;
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            background: var(--interactive-accent);
            color: var(--text-on-accent);
            cursor: pointer;
        `;
        confirmBtn.onclick = async () => {
            const confirmedText = textarea.value.trim();
            if (!confirmedText) {
                new Notice('Please enter your training notes');
                return;
            }

            // Disable buttons and show processing
            confirmBtn.disabled = true;
            reRecordBtn.disabled = true;
            confirmBtn.setText('Processing...');
            this.statusEl.setText('Processing your training notes...');
            this.statusEl.style.color = 'var(--text-accent)';

            try {
                let session;
                if (isContinuation) {
                    // CONTINUATION: Use confirmRespondToSession with the session ID
                    session = await this.plugin.confirmRespondToSession(sessionIdForContinuation, confirmedText);
                } else {
                    // NEW SESSION: Use confirmVoiceSession
                    session = await this.plugin.confirmVoiceSession(confirmedText);
                }
                this.displayResults(session);
            } catch (error) {
                console.error('Confirm error:', error);
                this.statusEl.setText('Error processing. Try again.');
                this.statusEl.style.color = 'var(--text-error)';
                confirmBtn.disabled = false;
                reRecordBtn.disabled = false;
                confirmBtn.setText('✓ Confirm & Process');
                new Notice(`Error: ${error.message || 'Could not process'}`);
            }
        };

        // Hide main record button during confirmation
        this.recordBtn.style.display = 'none';
    }

    displayResults(session: any) {
        this.resultEl.empty();
        this.currentSessionId = session.session_id;

        // Check if we have article/research results - this is the END state
        if (session.research?.article_sections?.length) {
            this.showArticlePlayer(session);
            return;
        }

        // THERAPY FLOW - clean and simple
        // Play audio response automatically
        if (session.response_audio_url) {
            const audioUrl = `${this.plugin.settings.serverUrl}${session.response_audio_url}`;
            const audio = new Audio(audioUrl);
            audio.play().catch(err => console.error('Audio error:', err));

            this.statusEl.setText('Oracle is speaking...');
            this.statusEl.style.color = 'var(--text-accent)';
            audio.onended = () => {
                this.statusEl.setText('Your turn - record your answer');
                this.statusEl.style.color = 'var(--text-success)';
            };
        }

        // Show coach's question prominently
        const questionContainer = this.resultEl.createDiv({ cls: 'coach-question' });
        questionContainer.style.background = 'var(--background-secondary)';
        questionContainer.style.padding = '20px';
        questionContainer.style.borderRadius = '12px';
        questionContainer.style.marginBottom = '20px';
        questionContainer.style.textAlign = 'center';

        const questionText = questionContainer.createEl('p', {
            text: session.response_text
        });
        questionText.style.fontSize = '1.2em';
        questionText.style.margin = '0';
        questionText.style.lineHeight = '1.5';
        questionText.style.textAlign = 'center';

        // Check state - if RESEARCHING, show big "Generate Wisdom" button
        if (session.state === 'RESEARCHING') {
            const isRemote = this.plugin.isRemoteMode();
            this.statusEl.setText(isRemote ? 'Ready to send to Oracle!' : 'Ready to generate wisdom!');
            this.statusEl.style.color = 'var(--text-success)';

            const bigBtnContainer = this.resultEl.createDiv();
            bigBtnContainer.style.textAlign = 'center';
            bigBtnContainer.style.marginTop = '30px';

            const generateBtn = bigBtnContainer.createEl('button', {
                text: isRemote ? '📤 Send to Oracle' : '✨ Generate Wisdom',
                cls: 'mod-cta'
            });
            generateBtn.style.fontSize = '1.4em';
            generateBtn.style.padding = '20px 40px';
            generateBtn.style.borderRadius = '12px';

            generateBtn.onclick = async () => {
                const sessionId = this.currentSessionId!;
                const plugin = this.plugin;
                const app = this.app;

                // Get topic from session
                const topic = session.selected_topic?.name || 'Research';

                if (isRemote) {
                    // REMOTE MODE: Send to coach queue
                    const therapyContext = {
                        conversation: session.conversation || [],
                        selected_topic: session.selected_topic
                    };

                    const jobId = await plugin.submitToCoach(topic, therapyContext);
                    if (jobId) {
                        new Notice('Query sent to Oracle! Check back later for results.', 5000);
                    }
                    this.close();
                    return;
                }

                // LOCAL MODE: Generate directly
                new Notice('Generating wisdom in background...', 3000);
                this.close();

                // Run in background
                try {
                    const response = await plugin.respondToSession(
                        sessionId,
                        'generate',
                        undefined,
                        undefined
                    );

                    // Get topic from response - prefer selected_topic, fallback to research.topic
                    const responseTopic = response.selected_topic?.name || response.research?.topic || session.selected_topic?.name || 'Research';

                    // Save to vault
                    if (response.research?.article_raw) {
                        const filename = await plugin.saveArticleToVault(responseTopic, response.research.article_raw);
                        new Notice(`Wisdom ready! Saved to ${filename}`, 3000);
                    }

                    // Open audio player if we have sections
                    if (response.research?.article_sections?.length > 0) {
                        const articleContent = response.research.article || response.research.article_raw || '';
                        const sources = response.research.sources || [];
                        const playerModal = new AudioPlayerModal(app, plugin, responseTopic, response.research.article_sections, sessionId, articleContent, sources);
                        playerModal.open();
                    } else {
                        new Notice('Research complete! Check your Flipmode folder.', 5000);
                    }
                } catch (error) {
                    console.error('Generate error:', error);
                    new Notice('Failed to generate wisdom. Try again.', 5000);
                }
            };

            // Hide record button during this state
            this.recordBtn.style.display = 'none';
            return;
        }

        // Normal therapy state - show record button for voice answer
        // Create a new button container at the bottom of resultEl (after the question)
        const answerBtnContainer = this.resultEl.createDiv({ cls: 'answer-btn-container' });
        answerBtnContainer.style.textAlign = 'center';
        answerBtnContainer.style.marginTop = '20px';
        answerBtnContainer.style.display = 'flex';
        answerBtnContainer.style.justifyContent = 'center';
        answerBtnContainer.style.gap = '15px';

        // Move the ANSWER button into this container
        answerBtnContainer.appendChild(this.recordBtn);

        this.recordBtn.setText('ANSWER');
        this.recordBtn.disabled = false;
        this.recordBtn.style.display = 'inline-flex';
        this.recordBtn.style.background = 'var(--interactive-accent)';

        // Add "Done" button to end the session (save notes only - athlete side)
        const doneBtn = answerBtnContainer.createEl('button', {
            text: 'DONE',
            cls: 'mod-cta'
        });
        doneBtn.style.cssText = `
            padding: 15px 30px;
            font-size: 1.1em;
            font-weight: bold;
            border-radius: 12px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: var(--interactive-accent);
            color: var(--text-on-accent);
        `;

        doneBtn.onclick = async () => {
            if (!this.currentSessionId) {
                new Notice('No session to save', 3000);
                this.close();
                return;
            }

            doneBtn.disabled = true;
            doneBtn.setText('Saving...');

            try {
                // Fetch session markdown from backend
                const response = await requestUrl({
                    url: `${this.plugin.settings.serverUrl}/api/obsidian/sync/session/${this.currentSessionId}`,
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                    }
                });

                const data = response.json;
                if (data.content) {
                    const season = this.plugin.settings.currentSeason;
                    const episode = this.plugin.settings.currentEpisode;
                    const athleteName = this.plugin.settings.athleteName || 'Athlete';
                    const dateStr = new Date().toISOString().split('T')[0];

                    // Extract MAIN focus - prefer selected_topic (what they chose to work on)
                    const frontmatter = data.frontmatter || {};
                    const topics = frontmatter.topics || [];  // work_on items
                    const wins = frontmatter.wins || [];

                    // Priority: selected_topic > first work_on topic > first win > general
                    let focus = frontmatter.selected_topic || topics[0] || wins[0] || 'general';
                    focus = focus.toLowerCase()
                        .replace(/[^a-z0-9\s]/g, '')
                        .replace(/\s+/g, '_')
                        .substring(0, 30);

                    // New naming: TrainingNotes-date-focus
                    const baseFilename = `TrainingNotes-${dateStr}-${focus}`;
                    const reviewFilename = `TrainingReview-${dateStr}-${focus}`;

                    // Per-athlete folder structure: Season X/Session Y
                    const folderPath = `${this.plugin.settings.syncFolder}/Athletes/${athleteName}/Season ${season}/Session ${episode}`;
                    const fullPath = `${folderPath}/${baseFilename}.md`;

                    // Ensure folder exists (create nested structure)
                    const folder = this.app.vault.getAbstractFileByPath(folderPath);
                    if (!folder) {
                        await this.app.vault.createFolder(folderPath);
                    }

                    // Find previous session's TrainingNotes for linear chain
                    let previousSessionLink = '';
                    if (episode > 1) {
                        const prevFolderPath = `${this.plugin.settings.syncFolder}/Athletes/${athleteName}/Season ${season}/Session ${episode - 1}`;
                        const prevFolder = this.app.vault.getAbstractFileByPath(prevFolderPath);
                        if (prevFolder instanceof TFolder) {
                            const prevFiles = prevFolder.children.filter(f => f instanceof TFile && f.name.startsWith('TrainingNotes-'));
                            if (prevFiles.length > 0) {
                                previousSessionLink = `\nprevious_session: "[[${(prevFiles[0] as TFile).basename}]]"`;
                            }
                        }
                    }

                    // Add enhanced frontmatter for graph view
                    // Note: coach_review link is added later when coach publishes review
                    const enhancedContent = `---
type: training-notes
season: ${season}
episode: ${episode}
date: ${dateStr}
focus: "${focus}"
session_id: "${this.currentSessionId}"${previousSessionLink}
tags: [bjj, training, season-${season}, ${focus.replace(/_/g, '-')}]
---

${data.content}
`;

                    // Save file
                    const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
                    if (existingFile instanceof TFile) {
                        await this.app.vault.modify(existingFile, enhancedContent);
                    } else {
                        await this.app.vault.create(fullPath, enhancedContent);
                    }

                    // Increment episode for next session
                    this.plugin.settings.currentEpisode = episode + 1;
                    await this.plugin.saveSettings();

                    new Notice(`Session saved: ${baseFilename}`, 3000);
                } else {
                    new Notice('Session ended', 3000);
                }
            } catch (error) {
                console.error('Error saving session:', error);
                new Notice('Session ended (save failed)', 3000);
            }

            this.close();
        };
    }

    showArticlePlayer(session: any) {
        this.statusEl.setText('Here\'s your wisdom');
        this.statusEl.style.color = 'var(--text-success)';

        // Article title
        const titleEl = this.resultEl.createEl('h3', {
            text: session.research.topic || 'Your Research'
        });
        titleEl.style.textAlign = 'center';
        titleEl.style.marginBottom = '20px';

        // Section audio player - clean list
        const sectionsContainer = this.resultEl.createDiv({ cls: 'article-sections' });
        sectionsContainer.style.background = 'var(--background-secondary)';
        sectionsContainer.style.padding = '15px';
        sectionsContainer.style.borderRadius = '12px';
        sectionsContainer.style.marginBottom = '20px';

        let currentAudio: HTMLAudioElement | null = null;

        for (const section of session.research.article_sections) {
            const sectionDiv = sectionsContainer.createDiv({ cls: 'section-item' });
            sectionDiv.style.display = 'flex';
            sectionDiv.style.alignItems = 'center';
            sectionDiv.style.gap = '12px';
            sectionDiv.style.padding = '10px';
            sectionDiv.style.cursor = 'pointer';
            sectionDiv.style.borderRadius = '8px';

            const playBtn = sectionDiv.createEl('span', { text: '▶' });
            playBtn.style.fontSize = '1.2em';
            playBtn.style.width = '24px';

            const titleEl = sectionDiv.createEl('span', { text: section.title });
            titleEl.style.flex = '1';
            titleEl.style.fontWeight = '500';

            const audioUrl = `${this.plugin.settings.serverUrl}${section.audio_url}`;
            const audio = new Audio(audioUrl);

            const playSection = () => {
                if (currentAudio && currentAudio !== audio) {
                    currentAudio.pause();
                }
                currentAudio = audio;
                audio.play();
                playBtn.setText('⏸');
                sectionDiv.style.background = 'var(--background-modifier-active-hover)';
            };

            sectionDiv.onclick = playSection;
            audio.onended = () => {
                playBtn.setText('▶');
                sectionDiv.style.background = '';
            };
            audio.onpause = () => {
                playBtn.setText('▶');
                sectionDiv.style.background = '';
            };
        }

        // Auto-play first section
        if (session.research.article_sections.length > 0) {
            const firstAudioUrl = `${this.plugin.settings.serverUrl}${session.research.article_sections[0].audio_url}`;
            const firstAudio = new Audio(firstAudioUrl);
            firstAudio.play().catch(() => {});
        }

        // Action buttons - Dive Deeper prominently
        const actionsContainer = this.resultEl.createDiv();
        actionsContainer.style.display = 'flex';
        actionsContainer.style.flexDirection = 'column';
        actionsContainer.style.gap = '12px';
        actionsContainer.style.marginTop = '20px';

        // Dive Deeper - big button with voice record
        const diveBtn = actionsContainer.createEl('button', {
            text: 'DIVE DEEPER',
            cls: 'mod-cta'
        });
        diveBtn.style.fontSize = '1.2em';
        diveBtn.style.padding = '15px 30px';
        diveBtn.onclick = () => {
            this.statusEl.setText('Record a follow-up question...');
            this.recordBtn.setText('RECORD FOLLOW-UP');
            this.recordBtn.disabled = false;
            this.recordBtn.style.display = 'inline-block';
            // Scroll to record button
            this.recordBtn.scrollIntoView({ behavior: 'smooth' });
        };

        // Training Plan - secondary
        const planBtn = actionsContainer.createEl('button', {
            text: 'CREATE TRAINING PLAN'
        });
        planBtn.style.padding = '12px 24px';
        planBtn.onclick = async () => {
            planBtn.disabled = true;
            planBtn.setText('Creating...');
            try {
                const topic = session.research?.topic || session.selected_topic?.name || 'Training';
                const article = session.research?.article || session.research?.article_raw || '';
                const response = await this.plugin.apiRequest('/training-plan', 'POST', {
                    session_id: this.currentSessionId,
                    user_id: this.plugin.settings.userId,
                    topic: topic,
                    article: article  // Pass article for training recommendations extraction
                });

                if (response.markdown) {
                    // Save training plan to vault
                    const cleanTopic = topic.replace(/[\\/:*?"<>|]/g, '-').substring(0, 40);
                    const date = new Date().toISOString().split('T')[0];
                    const filename = `${this.plugin.settings.syncFolder}/Plans/${date} - ${cleanTopic} Plan.md`;

                    // Ensure folder exists
                    const planFolder = `${this.plugin.settings.syncFolder}/Plans`;
                    const folder = this.app.vault.getAbstractFileByPath(planFolder);
                    if (!folder) {
                        await this.app.vault.createFolder(planFolder);
                    }

                    // Create file
                    const existingFile = this.app.vault.getAbstractFileByPath(filename);
                    if (existingFile instanceof TFile) {
                        await this.app.vault.modify(existingFile, response.markdown);
                    } else {
                        await this.app.vault.create(filename, response.markdown);
                    }

                    // Open the file
                    const file = this.app.vault.getAbstractFileByPath(filename);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
                    }

                    new Notice(`Training plan saved to ${filename}`);
                } else {
                    new Notice('Plan created but no content returned');
                }
            } catch (error) {
                console.error('Plan error:', error);
                new Notice('Failed to create plan');
                planBtn.disabled = false;
                planBtn.setText('CREATE TRAINING PLAN');
            }
        };

        // Hide record button initially
        this.recordBtn.style.display = 'none';
    }

    blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = (reader.result as string).split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    onClose() {
        // Stop recording if still active
        if (this.isRecording && this.mediaRecorder) {
            this.mediaRecorder.stop();
        }
        if (this.timerInterval) {
            window.clearInterval(this.timerInterval);
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Dive Deep Modal - for session-based follow-up research
class DiveDeepModal extends Modal {
    plugin: BJJFlipmodePlugin;
    topic: string;
    sessionContext: string;
    rlmSessionId: string;
    mediaRecorder: MediaRecorder | null = null;
    audioChunks: Blob[] = [];
    isRecording: boolean = false;
    recordBtn: HTMLButtonElement;
    statusEl: HTMLElement;

    constructor(app: App, plugin: BJJFlipmodePlugin, topic: string, sessionContext: string, rlmSessionId: string = '') {
        super(app);
        this.plugin = plugin;
        this.topic = topic;
        this.sessionContext = sessionContext;
        this.rlmSessionId = rlmSessionId;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flipmode-dive-deep-modal');

        // Title
        const titleEl = contentEl.createEl('h2', { text: 'Dive Deeper' });
        titleEl.style.textAlign = 'center';

        // Topic display
        const topicEl = contentEl.createEl('p', { text: `Topic: ${this.topic}` });
        topicEl.style.textAlign = 'center';
        topicEl.style.color = 'var(--text-accent)';
        topicEl.style.fontWeight = '600';

        // Session context
        const contextContainer = contentEl.createDiv();
        contextContainer.style.background = 'var(--background-secondary)';
        contextContainer.style.padding = '15px';
        contextContainer.style.borderRadius = '8px';
        contextContainer.style.marginBottom = '20px';
        contextContainer.style.maxHeight = '150px';
        contextContainer.style.overflowY = 'auto';

        const contextLabel = contextContainer.createEl('p', { text: 'Session Notes:' });
        contextLabel.style.fontWeight = '600';
        contextLabel.style.marginBottom = '8px';

        const contextText = contextContainer.createEl('p', { text: this.sessionContext });
        contextText.style.fontSize = '0.9em';
        contextText.style.whiteSpace = 'pre-wrap';

        // Status
        this.statusEl = contentEl.createEl('p', { text: 'Record your follow-up question' });
        this.statusEl.style.textAlign = 'center';
        this.statusEl.style.color = 'var(--text-muted)';

        // Record button
        const btnContainer = contentEl.createDiv();
        btnContainer.style.textAlign = 'center';
        btnContainer.style.marginTop = '20px';

        this.recordBtn = btnContainer.createEl('button', { text: 'RECORD QUESTION', cls: 'mod-cta' });
        this.recordBtn.style.padding = '16px 32px';
        this.recordBtn.style.fontSize = '1.1em';
        this.recordBtn.onclick = () => this.toggleRecording();
    }

    async toggleRecording() {
        if (this.isRecording) {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioChunks = [];
            this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.audioChunks.push(e.data);
            };

            this.mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                await this.processRecording();
            };

            this.mediaRecorder.start();
            this.isRecording = true;
            this.recordBtn.setText('STOP');
            this.recordBtn.style.background = 'var(--text-error)';
            this.statusEl.setText('Recording... speak your question');
        } catch (error) {
            new Notice('Could not access microphone');
        }
    }

    async stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
        }
    }

    async processRecording() {
        this.recordBtn.setText('PROCESSING...');
        this.recordBtn.disabled = true;
        this.statusEl.setText('Sending to Flipmode...');

        try {
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
            const base64Audio = await this.blobToBase64(audioBlob);

            // Start new session with context pre-filled
            const sessionResponse = await this.plugin.apiRequest('/session', 'POST', {
                user_id: this.plugin.settings.userId
            });

            // Send the audio with topic context
            const response = await this.plugin.apiRequest('/respond', 'POST', {
                session_id: sessionResponse.session_id,
                audio_base64: base64Audio,
                audio_format: 'webm',
                context: `Follow-up on ${this.topic}. Session notes: ${this.sessionContext}`
            });

            new Notice('Researching in background...', 3000);
            this.close();

            // If we got a direct research response, handle it
            if (response.research?.article_sections?.length > 0) {
                const articleContent = response.research.article || response.research.article_raw || '';
                const sources = response.research.sources || [];
                // Open player - it will save the article with audio
                const playerModal = new AudioPlayerModal(
                    this.app,
                    this.plugin,
                    this.topic + ' - Follow-up',
                    response.research.article_sections,
                    sessionResponse.session_id,
                    articleContent,
                    sources
                );
                playerModal.open();
            }

        } catch (error) {
            console.error('Dive deep error:', error);
            new Notice('Failed to process - try again');
            this.recordBtn.setText('RECORD QUESTION');
            this.recordBtn.disabled = false;
        }
    }

    blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    onClose() {
        if (this.isRecording && this.mediaRecorder) {
            this.mediaRecorder.stop();
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Auto-playing Audio Player Modal
class AudioPlayerModal extends Modal {
    plugin: BJJFlipmodePlugin;
    topic: string;
    sections: any[];
    sessionId: string | null;
    articleContent: string;
    sources: any[];  // Video sources with timestamps
    currentIndex: number = 0;
    currentAudio: HTMLAudioElement | null = null;
    isPlaying: boolean = false;
    volume: number = 0.8;
    statusEl: HTMLElement;
    sectionItems: HTMLElement[] = [];
    savedFilePath: string | null = null;

    constructor(app: App, plugin: BJJFlipmodePlugin, topic: string, sections: any[], sessionId?: string, articleContent?: string, sources?: any[]) {
        super(app);
        this.plugin = plugin;
        this.topic = topic;
        this.sections = sections;
        this.sessionId = sessionId || null;
        this.articleContent = articleContent || '';
        this.sources = sources || [];
    }

    async saveResearchToVault(): Promise<string | null> {
        if (!this.articleContent) {
            return null;
        }

        try {
            const cleanTopic = this.topic.replace(/[\\/:*?"<>|]/g, '-').substring(0, 50);
            const date = new Date().toISOString().split('T')[0];
            const baseFolder = this.plugin.settings.syncFolder;
            const researchFolder = `${baseFolder}/Research`;
            // Audio goes in topic-specific subfolder - keeps graph clean
            const topicAudioFolder = `${researchFolder}/audio/${cleanTopic}`;

            // Ensure folders exist
            for (const folder of [baseFolder, researchFolder, `${researchFolder}/audio`, topicAudioFolder]) {
                const existing = this.app.vault.getAbstractFileByPath(folder);
                if (!existing) {
                    await this.app.vault.createFolder(folder);
                }
            }

            // Download audio files and build embed links
            // Files named simply: 01-Core Thesis.mp3 (no topic prefix - folder provides context)
            const audioEmbeds: string[] = [];
            for (let i = 0; i < this.sections.length; i++) {
                const section = this.sections[i];
                const sectionNum = String(i + 1).padStart(2, '0');
                const cleanSectionTitle = section.title.replace(/[\\/:*?"<>|]/g, '-').substring(0, 40);
                const audioFilename = `${sectionNum}-${cleanSectionTitle}.mp3`;
                const audioPath = `${topicAudioFolder}/${audioFilename}`;

                try {
                    // Download audio from server
                    const audioUrl = `${this.plugin.settings.serverUrl}${section.audio_url}`;
                    const response = await fetch(audioUrl, {
                        headers: {
                            'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                        }
                    });

                    if (response.ok) {
                        const audioBlob = await response.blob();
                        const arrayBuffer = await audioBlob.arrayBuffer();

                        // Save to vault
                        const existingAudio = this.app.vault.getAbstractFileByPath(audioPath);
                        if (existingAudio instanceof TFile) {
                            await this.app.vault.modifyBinary(existingAudio, arrayBuffer);
                        } else {
                            await this.app.vault.createBinary(audioPath, arrayBuffer);
                        }

                        // Use full path for embed so Obsidian finds it correctly
                        audioEmbeds.push(`### ${section.title}\n![[${audioPath}]]`);
                    }
                } catch (err) {
                    console.error(`Failed to download audio for section ${i}:`, err);
                    audioEmbeds.push(`### ${section.title}\n*Audio not available*`);
                }
            }

            // Build markdown content with audio embeds
            const markdownContent = `---
topic: "${this.topic}"
date: ${date}
type: research
---

# ${this.topic}

${this.articleContent}

---

## 🎧 Audio Sections

${audioEmbeds.join('\n\n')}
`;

            // Save markdown file
            const filename = `${researchFolder}/${date} - ${cleanTopic}.md`;
            const existingFile = this.app.vault.getAbstractFileByPath(filename);
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, markdownContent);
            } else {
                await this.app.vault.create(filename, markdownContent);
            }

            this.savedFilePath = filename;
            return filename;
        } catch (error) {
            console.error('Error saving research to vault:', error);
            return null;
        }
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flipmode-audio-player');

        // Title - use the actual topic
        const titleEl = contentEl.createEl('h2', { text: this.topic || 'Research' });
        titleEl.style.textAlign = 'center';
        titleEl.style.marginBottom = '10px';

        // Status
        this.statusEl = contentEl.createEl('p', { text: this.articleContent ? 'Saving to vault...' : 'Ready to play' });
        this.statusEl.style.textAlign = 'center';
        this.statusEl.style.color = 'var(--text-muted)';
        this.statusEl.style.marginBottom = '20px';

        // Auto-save research to vault in background (only if we have article content)
        if (this.articleContent) {
            this.saveResearchToVault().then(savedPath => {
                if (savedPath) {
                    new Notice(`Research saved to ${savedPath}`, 3000);
                }
            });
        }

        // Sections list
        const sectionsContainer = contentEl.createDiv({ cls: 'audio-sections' });
        sectionsContainer.style.background = 'var(--background-secondary)';
        sectionsContainer.style.padding = '15px';
        sectionsContainer.style.borderRadius = '12px';
        sectionsContainer.style.marginBottom = '20px';
        sectionsContainer.style.maxHeight = '300px';
        sectionsContainer.style.overflowY = 'auto';

        this.sections.forEach((section, index) => {
            const sectionDiv = sectionsContainer.createDiv({ cls: 'section-item' });
            sectionDiv.style.display = 'flex';
            sectionDiv.style.alignItems = 'center';
            sectionDiv.style.gap = '12px';
            sectionDiv.style.padding = '10px';
            sectionDiv.style.borderRadius = '8px';
            sectionDiv.style.cursor = 'pointer';

            const indicator = sectionDiv.createEl('span', { text: '○' });
            indicator.style.fontSize = '1em';
            indicator.style.width = '20px';
            indicator.addClass('section-indicator');

            const titleSpan = sectionDiv.createEl('span', { text: section.title });
            titleSpan.style.flex = '1';

            sectionDiv.onclick = () => this.playSection(index);
            this.sectionItems.push(sectionDiv);
        });

        // Controls
        const controlsContainer = contentEl.createDiv();
        controlsContainer.style.display = 'flex';
        controlsContainer.style.justifyContent = 'center';
        controlsContainer.style.alignItems = 'center';
        controlsContainer.style.gap = '10px';
        controlsContainer.style.marginTop = '20px';

        // Transport controls container (prev/pause/next)
        const transportControls = controlsContainer.createDiv();
        transportControls.style.display = 'flex';
        transportControls.style.alignItems = 'center';
        transportControls.style.gap = '5px';
        transportControls.style.background = 'var(--background-secondary)';
        transportControls.style.borderRadius = '25px';
        transportControls.style.padding = '5px 10px';

        // Previous button
        const prevBtn = transportControls.createEl('button', { text: '⏮' });
        prevBtn.style.padding = '10px 15px';
        prevBtn.style.fontSize = '1.2em';
        prevBtn.style.border = 'none';
        prevBtn.style.background = 'transparent';
        prevBtn.style.cursor = 'pointer';
        prevBtn.title = 'Previous section';
        prevBtn.onclick = () => {
            if (this.currentIndex > 0) {
                this.playSection(this.currentIndex - 1);
            }
        };

        // Pause/Play button
        const pauseBtn = transportControls.createEl('button', { text: '⏸' });
        pauseBtn.style.padding = '10px 20px';
        pauseBtn.style.fontSize = '1.4em';
        pauseBtn.style.border = 'none';
        pauseBtn.style.background = 'var(--interactive-accent)';
        pauseBtn.style.color = 'var(--text-on-accent)';
        pauseBtn.style.borderRadius = '50%';
        pauseBtn.style.width = '50px';
        pauseBtn.style.height = '50px';
        pauseBtn.style.cursor = 'pointer';
        pauseBtn.title = 'Pause/Resume';
        pauseBtn.onclick = () => {
            if (this.currentAudio) {
                if (this.isPlaying) {
                    this.currentAudio.pause();
                    pauseBtn.setText('▶');
                    this.isPlaying = false;
                } else {
                    this.currentAudio.play();
                    pauseBtn.setText('⏸');
                    this.isPlaying = true;
                }
            }
        };

        // Next button
        const nextBtn = transportControls.createEl('button', { text: '⏭' });
        nextBtn.style.padding = '10px 15px';
        nextBtn.style.fontSize = '1.2em';
        nextBtn.style.border = 'none';
        nextBtn.style.background = 'transparent';
        nextBtn.style.cursor = 'pointer';
        nextBtn.title = 'Next section';
        nextBtn.onclick = () => {
            if (this.currentIndex < this.sections.length - 1) {
                this.playSection(this.currentIndex + 1);
            }
        };

        // Volume control
        const volumeContainer = controlsContainer.createDiv();
        volumeContainer.style.display = 'flex';
        volumeContainer.style.alignItems = 'center';
        volumeContainer.style.gap = '8px';

        const volumeIcon = volumeContainer.createEl('span', { text: '🔊' });
        volumeIcon.style.fontSize = '1.2em';

        const volumeSlider = volumeContainer.createEl('input') as HTMLInputElement;
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = String(this.volume * 100);
        volumeSlider.style.width = '80px';
        volumeSlider.style.cursor = 'pointer';
        volumeSlider.oninput = () => {
            this.volume = parseInt(volumeSlider.value) / 100;
            if (this.currentAudio) {
                this.currentAudio.volume = this.volume;
            }
            // Update icon based on volume
            if (this.volume === 0) {
                volumeIcon.setText('🔇');
            } else if (this.volume < 0.5) {
                volumeIcon.setText('🔉');
            } else {
                volumeIcon.setText('🔊');
            }
        };

        // Training Plan button - only show if we have article content
        if (!this.articleContent) {
            // Skip training plan button when opened from TrainingReview
        } else {
        const planBtn = controlsContainer.createEl('button', { text: 'TRAINING PLAN' });
        planBtn.style.padding = '12px 24px';
        planBtn.onclick = async () => {
            planBtn.disabled = true;
            planBtn.setText('Creating plan...');
            try {
                // Pass sources to extract video clips for drills
                const response = await this.plugin.apiRequest('/training-plan', 'POST', {
                    session_id: this.sessionId,
                    user_id: this.plugin.settings.userId,
                    topic: this.topic,
                    article: this.articleContent,
                    sources: this.sources,  // Pass sources for video clip extraction
                    include_video_refs: true
                });

                if (response.markdown) {
                    // Save training plan to vault
                    const cleanTopic = this.topic.replace(/[\\/:*?"<>|]/g, '-').substring(0, 40);
                    const date = new Date().toISOString().split('T')[0];
                    const planFilename = `${this.plugin.settings.syncFolder}/Plans/${date} - ${cleanTopic} Plan.md`;

                    // Ensure folders exist
                    const planFolder = `${this.plugin.settings.syncFolder}/Plans`;
                    const folder = this.app.vault.getAbstractFileByPath(planFolder);
                    if (!folder) {
                        await this.app.vault.createFolder(planFolder);
                    }

                    // Create clips folder hierarchy for this plan
                    const clipsBaseFolder = `${planFolder}/clips`;
                    const clipsBaseFolderObj = this.app.vault.getAbstractFileByPath(clipsBaseFolder);
                    if (!clipsBaseFolderObj) {
                        await this.app.vault.createFolder(clipsBaseFolder);
                    }
                    const clipsFolder = `${clipsBaseFolder}/${cleanTopic}`;
                    const clipsFolderObj = this.app.vault.getAbstractFileByPath(clipsFolder);
                    if (!clipsFolderObj) {
                        await this.app.vault.createFolder(clipsFolder);
                    }

                    // Download and save video clips if any were extracted
                    let videoSection = '';
                    if (response.clips && response.clips.length > 0) {
                        planBtn.setText(`Downloading ${response.clips.length} clips...`);
                        const clipEmbeds: string[] = [];

                        for (const clip of response.clips) {
                            try {
                                // Download clip from API
                                const clipResponse = await requestUrl({
                                    url: `${this.plugin.settings.serverUrl}${clip.clip_url}`,
                                    method: 'GET',
                                    headers: {
                                        'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                                    }
                                });

                                // Save clip to vault (skip if already exists)
                                const clipFilename = `${clip.instructor.replace(/[\\/:*?"<>|]/g, '-')} - ${clip.timestamp.replace(/:/g, '-')}.mp4`;
                                const clipPath = `${clipsFolder}/${clipFilename}`;

                                const existingClip = this.app.vault.getAbstractFileByPath(clipPath);
                                if (!existingClip) {
                                    await this.app.vault.createBinary(clipPath, clipResponse.arrayBuffer);
                                }

                                // Build embed for this clip
                                clipEmbeds.push(`#### ${clip.instructor} @ ${clip.timestamp}\n![[${clipPath}]]`);
                            } catch (clipError) {
                                console.error('Failed to download clip:', clipError);
                            }
                        }

                        if (clipEmbeds.length > 0) {
                            videoSection = `\n\n## Reference Video Clips\n\nThese clips show the actual techniques from the research sources. Watch them to see how the moves should look:\n\n${clipEmbeds.join('\n\n')}\n`;
                        }
                    }

                    // Get the research file name for linking
                    let researchLink = '';
                    if (this.savedFilePath) {
                        const researchFileName = this.savedFilePath.split('/').pop()?.replace('.md', '') || '';
                        researchLink = `> **Based on research:** [[${researchFileName}]]\n\n`;
                    }

                    // Add frontmatter, research link, content, and video section
                    const planContent = `---
topic: "${this.topic}"
date: ${date}
type: training-plan
research: "${this.savedFilePath || ''}"
clips: ${response.clips?.length || 0}
---

${researchLink}${response.markdown}${videoSection}`;

                    // Create or update file
                    const existingFile = this.app.vault.getAbstractFileByPath(planFilename);
                    if (existingFile instanceof TFile) {
                        await this.app.vault.modify(existingFile, planContent);
                    } else {
                        await this.app.vault.create(planFilename, planContent);
                    }

                    // Open the file
                    const file = this.app.vault.getAbstractFileByPath(planFilename);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
                    }

                    const clipMsg = response.clips?.length ? ` with ${response.clips.length} video clips` : '';
                    new Notice(`Training plan saved${clipMsg}`);
                    planBtn.setText('TRAINING PLAN');
                    planBtn.disabled = false;
                } else {
                    new Notice('Plan created but no content returned');
                    planBtn.setText('TRAINING PLAN');
                    planBtn.disabled = false;
                }
            } catch (error) {
                console.error('Plan error:', error);
                new Notice('Failed to create plan');
                planBtn.disabled = false;
                planBtn.setText('TRAINING PLAN');
            }
        };

        // View in vault button - only show if we have article content
        const viewBtn = controlsContainer.createEl('button', { text: 'VIEW IN VAULT' });
        viewBtn.style.padding = '12px 24px';
        viewBtn.onclick = async () => {
            if (this.savedFilePath) {
                const file = this.app.vault.getAbstractFileByPath(this.savedFilePath);
                if (file instanceof TFile) {
                    await this.app.workspace.getLeaf().openFile(file);
                    this.close();
                }
            } else {
                new Notice('Still saving... please wait');
            }
        };
        } // End of articleContent conditional block

        const closeBtn = controlsContainer.createEl('button', { text: 'CLOSE' });
        closeBtn.style.padding = '12px 24px';
        closeBtn.onclick = () => this.close();

        // Start playing
        if (this.sections.length > 0) {
            this.playSection(0);
        }
    }

    playSection(index: number) {
        // Stop current audio if playing
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }

        // Check if playback complete (all sections played)
        if (index >= this.sections.length) {
            this.isPlaying = false;
            this.statusEl.setText('✓ Playback complete - click any section to replay');
            // Mark all sections as complete
            this.sectionItems.forEach((item) => {
                const indicator = item.querySelector('.section-indicator') as HTMLElement;
                indicator.setText('✓');
                item.style.opacity = '1';
                item.style.background = '';
            });
            return;
        }

        // Update UI
        this.currentIndex = index;
        this.sectionItems.forEach((item, i) => {
            const indicator = item.querySelector('.section-indicator') as HTMLElement;
            if (i < index) {
                indicator.setText('✓');
                item.style.opacity = '0.7';
                item.style.background = '';
            } else if (i === index) {
                indicator.setText('▶');
                item.style.background = 'var(--background-modifier-active-hover)';
                item.style.opacity = '1';
            } else {
                indicator.setText('○');
                item.style.background = '';
                item.style.opacity = '1';
            }
        });

        const section = this.sections[index];
        this.statusEl.setText(`Playing: ${section.title}`);

        // Play audio
        const audioUrl = `${this.plugin.settings.serverUrl}${section.audio_url}`;
        this.currentAudio = new Audio(audioUrl);
        this.currentAudio.volume = this.volume;
        this.isPlaying = true;

        this.currentAudio.play().catch(err => {
            console.error('Audio play error:', err);
            this.statusEl.setText(`Error playing ${section.title} - click to retry`);
        });

        // Auto-advance to next section
        this.currentAudio.onended = () => {
            this.sectionItems[index].style.background = '';
            this.playSection(index + 1);
        };

        // Handle audio errors
        this.currentAudio.onerror = () => {
            console.error('Audio load error for section:', section.title);
            this.statusEl.setText(`Error loading audio - click section to retry`);
        };
    }

    onClose() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Coach Add Athlete Modal
class CoachAddAthleteModal extends Modal {
    plugin: BJJFlipmodePlugin;

    constructor(app: App, plugin: BJJFlipmodePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Add Athlete to Roster' });

        let discordId = '';
        let displayName = '';

        new Setting(contentEl)
            .setName('Discord ID')
            .setDesc('The athlete\'s Discord user ID (18-digit number)')
            .addText(text => text
                .setPlaceholder('123456789012345678')
                .onChange(value => discordId = value));

        new Setting(contentEl)
            .setName('Display Name')
            .setDesc('Optional friendly name')
            .addText(text => text
                .setPlaceholder('John Doe')
                .onChange(value => displayName = value));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Add Athlete')
                .setCta()
                .onClick(async () => {
                    if (!discordId) {
                        new Notice('Discord ID is required');
                        return;
                    }
                    try {
                        await this.plugin.coachClient!.addAthlete(discordId, displayName || undefined);
                        new Notice('Athlete added to roster!');
                        this.close();
                    } catch (error) {
                        new Notice('Failed to add athlete');
                    }
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Athlete selection modal for sharing content
class AthleteSelectModal extends Modal {
    athletes: any[];
    onSelect: (athlete: any) => void;

    constructor(app: App, athletes: any[], onSelect: (athlete: any) => void) {
        super(app);
        this.athletes = athletes;
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Select Athlete' });
        contentEl.createEl('p', { text: 'Choose an athlete to share this content with:' });

        const listEl = contentEl.createEl('div', { cls: 'athlete-select-list' });

        for (const athlete of this.athletes) {
            const athleteEl = listEl.createEl('div', { cls: 'athlete-select-item' });
            athleteEl.style.cssText = 'padding: 10px; margin: 5px 0; border-radius: 5px; cursor: pointer; background: var(--background-secondary);';

            const name = athlete.display_name || athlete.discord_username || `Athlete ${athlete.id}`;
            athleteEl.createEl('strong', { text: name });

            if (athlete.discord_username && athlete.discord_username !== name) {
                athleteEl.createEl('span', {
                    text: ` (@${athlete.discord_username})`,
                    cls: 'athlete-discord-name'
                });
            }

            athleteEl.addEventListener('click', () => {
                this.onSelect(athlete);
                this.close();
            });

            athleteEl.addEventListener('mouseenter', () => {
                athleteEl.style.background = 'var(--background-modifier-hover)';
            });
            athleteEl.addEventListener('mouseleave', () => {
                athleteEl.style.background = 'var(--background-secondary)';
            });
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Article Bibliography Modal - Shows ALL videos from an Oracle article
class ArticleBibliographyModal extends Modal {
    plugin: BJJFlipmodePlugin;
    bibliographyData: any;
    sourceFile: TFile;

    constructor(app: App, plugin: BJJFlipmodePlugin, bibliographyData: any, sourceFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.bibliographyData = bibliographyData;
        this.sourceFile = sourceFile;
    }

    onOpen() {
        const { contentEl } = this;
        const { bibliographyData } = this;

        // Header
        contentEl.createEl('h2', { text: 'Article Source Videos' });

        // Original query
        const queryEl = contentEl.createEl('div', { cls: 'original-query' });
        queryEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-secondary); border-radius: 5px; border-left: 3px solid var(--interactive-accent);';
        queryEl.createEl('p', {
            text: `Original Question: "${bibliographyData.original_query}"`,
            cls: 'query-text'
        });

        // Stats
        const statsEl = contentEl.createEl('div', { cls: 'bibliography-stats' });
        statsEl.style.cssText = 'margin-bottom: 15px; display: flex; gap: 15px;';
        statsEl.createEl('span', { text: `📹 ${bibliographyData.total_videos} videos` });
        statsEl.createEl('span', { text: `👤 ${bibliographyData.instructors.length} instructors` });

        // Instructions
        contentEl.createEl('p', {
            text: 'Click any video to view its full concept cache with timestamps:',
            cls: 'bibliography-instructions'
        });

        // Videos list - grouped by instructor
        const listEl = contentEl.createEl('div', { cls: 'videos-list' });
        listEl.style.cssText = 'max-height: 450px; overflow-y: auto;';

        // Group videos by instructor
        const byInstructor: { [key: string]: any[] } = {};
        for (const video of bibliographyData.videos) {
            const instructor = video.instructor || 'Unknown';
            if (!byInstructor[instructor]) {
                byInstructor[instructor] = [];
            }
            byInstructor[instructor].push(video);
        }

        // Render each instructor group
        for (const instructor of Object.keys(byInstructor).sort()) {
            const groupEl = listEl.createEl('div', { cls: 'instructor-group' });
            groupEl.style.cssText = 'margin-bottom: 15px;';

            const headerEl = groupEl.createEl('h3', { text: `👤 ${instructor}` });
            headerEl.style.cssText = 'margin: 10px 0 5px 0; font-size: 1.1em; color: var(--text-accent);';

            for (const video of byInstructor[instructor]) {
                const videoEl = groupEl.createEl('div', { cls: 'video-item' });
                videoEl.style.cssText = 'padding: 10px; margin: 5px 0; border-radius: 5px; background: var(--background-secondary); cursor: pointer; border-left: 3px solid var(--interactive-accent);';

                // Title row
                const titleRow = videoEl.createEl('div', { cls: 'title-row' });
                titleRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

                titleRow.createEl('strong', { text: video.video_title });

                // Citations badge
                const citationsBadge = titleRow.createEl('span', { cls: 'citations-badge' });
                citationsBadge.style.cssText = 'background: var(--interactive-accent); color: white; padding: 2px 8px; border-radius: 10px; font-size: 0.8em;';
                citationsBadge.textContent = `${video.citations_count} citation${video.citations_count !== 1 ? 's' : ''}`;

                // Timestamps preview
                if (video.timestamps && video.timestamps.length > 0) {
                    const timestampsEl = videoEl.createEl('div', { cls: 'timestamps-preview' });
                    timestampsEl.style.cssText = 'margin-top: 5px; font-size: 0.85em; color: var(--text-muted);';
                    timestampsEl.textContent = `Timestamps: ${video.timestamps.slice(0, 5).join(', ')}${video.timestamps.length > 5 ? '...' : ''}`;
                }

                // Click handler - open VideoExplorerModal with this video's concept cache
                videoEl.addEventListener('click', async () => {
                    videoEl.style.background = 'var(--background-modifier-hover)';
                    titleRow.createEl('span', { text: ' Loading...', cls: 'loading-text' });

                    try {
                        // Get the full concept cache for this video
                        const response = await requestUrl({
                            url: `${this.plugin.settings.serverUrl}/api/obsidian/explore-video`,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                            },
                            body: JSON.stringify({
                                video_id: video.video_id,
                                concept: video.video_title  // Use video title as fallback
                            })
                        });

                        const data = response.json;

                        if (data.error) {
                            new Notice(`Could not load concept cache for this video`, 3000);
                            videoEl.style.background = 'var(--background-secondary)';
                            const loadingText = videoEl.querySelector('.loading-text');
                            if (loadingText) loadingText.remove();
                            return;
                        }

                        // Close bibliography and open video explorer
                        this.close();
                        const modal = new VideoExplorerModal(
                            this.app,
                            this.plugin,
                            data,
                            this.sourceFile
                        );
                        modal.open();

                    } catch (error: any) {
                        new Notice(`Failed to load: ${error.message}`, 3000);
                        videoEl.style.background = 'var(--background-secondary)';
                        const loadingText = videoEl.querySelector('.loading-text');
                        if (loadingText) loadingText.remove();
                    }
                });

                // Hover effects
                videoEl.addEventListener('mouseenter', () => {
                    videoEl.style.background = 'var(--background-modifier-hover)';
                });
                videoEl.addEventListener('mouseleave', () => {
                    videoEl.style.background = 'var(--background-secondary)';
                });
            }
        }

        // Footer
        const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
        footerEl.style.cssText = 'margin-top: 20px; display: flex; gap: 10px;';

        new Setting(footerEl)
            .addButton(btn => btn
                .setButtonText('Close')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Catalog Browser Modal - Browse full video catalog and select for cross-reference
class CatalogBrowserModal extends Modal {
    plugin: BJJFlipmodePlugin;
    concept: string;
    conceptContext: string;
    sourceFile: TFile;
    selectedVideos: Set<string> = new Set();
    catalogData: any = null;

    constructor(app: App, plugin: BJJFlipmodePlugin, concept: string, conceptContext: string, sourceFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.concept = concept;
        this.conceptContext = conceptContext;
        this.sourceFile = sourceFile;
    }

    async onOpen() {
        const { contentEl } = this;

        // Header
        contentEl.createEl('h2', { text: 'Cross-Reference Research' });

        // Concept info
        const conceptEl = contentEl.createEl('div', { cls: 'concept-info' });
        conceptEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-secondary); border-radius: 5px; border-left: 3px solid var(--interactive-accent);';
        conceptEl.createEl('p', { text: `Concept: "${this.concept}"` });
        if (this.conceptContext) {
            conceptEl.createEl('p', { text: `Context: ${this.conceptContext}`, cls: 'context-text' });
        }

        // Loading indicator
        const loadingEl = contentEl.createEl('div', { cls: 'loading', text: 'Loading video catalog...' });
        loadingEl.style.cssText = 'padding: 20px; text-align: center;';

        try {
            // Fetch catalog
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/obsidian/catalog`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                }
            });

            this.catalogData = response.json;
            loadingEl.remove();

            // Instructions
            contentEl.createEl('p', {
                text: `Select videos to cross-reference (${this.catalogData.total_videos} available):`,
                cls: 'catalog-instructions'
            });

            // Selected count display
            const selectedCountEl = contentEl.createEl('div', { cls: 'selected-count' });
            selectedCountEl.style.cssText = 'margin-bottom: 10px; font-weight: bold; color: var(--text-accent);';
            selectedCountEl.textContent = '0 videos selected';

            // Search filter
            const searchEl = contentEl.createEl('input', { type: 'text', placeholder: 'Filter instructors/series...' });
            searchEl.style.cssText = 'width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 5px; border: 1px solid var(--background-modifier-border);';

            // Catalog list
            const listEl = contentEl.createEl('div', { cls: 'catalog-list' });
            listEl.style.cssText = 'max-height: 350px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 5px; padding: 10px;';

            const updateSelectedCount = () => {
                selectedCountEl.textContent = `${this.selectedVideos.size} videos selected`;
            };

            const renderCatalog = (filter: string = '') => {
                listEl.empty();
                const filterLower = filter.toLowerCase();

                for (const instructor of this.catalogData.instructors) {
                    // Check if instructor matches filter
                    const instructorMatches = instructor.name.toLowerCase().includes(filterLower);
                    const matchingSeries = instructor.series.filter((s: any) =>
                        instructorMatches || s.name.toLowerCase().includes(filterLower)
                    );

                    if (matchingSeries.length === 0 && !instructorMatches) continue;

                    // Instructor group
                    const groupEl = listEl.createEl('div', { cls: 'instructor-group' });
                    groupEl.style.cssText = 'margin-bottom: 10px;';

                    // Instructor header with expand/collapse
                    const headerEl = groupEl.createEl('div', { cls: 'instructor-header' });
                    headerEl.style.cssText = 'display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 5px; background: var(--background-secondary); border-radius: 3px;';

                    const expandIcon = headerEl.createEl('span', { text: '▶' });
                    expandIcon.style.cssText = 'font-size: 0.8em; transition: transform 0.2s;';

                    // Select all checkbox for instructor
                    const instructorCheckbox = headerEl.createEl('input', { type: 'checkbox' });
                    instructorCheckbox.style.cssText = 'margin-right: 5px;';

                    headerEl.createEl('strong', { text: `${instructor.name} (${instructor.video_count})` });

                    // Series container (collapsible)
                    const seriesContainer = groupEl.createEl('div', { cls: 'series-container' });
                    seriesContainer.style.cssText = 'display: none; margin-left: 20px; margin-top: 5px;';

                    // Toggle expand/collapse
                    headerEl.addEventListener('click', (e) => {
                        if (e.target === instructorCheckbox) return;
                        const isExpanded = seriesContainer.style.display !== 'none';
                        seriesContainer.style.display = isExpanded ? 'none' : 'block';
                        expandIcon.style.transform = isExpanded ? '' : 'rotate(90deg)';
                    });

                    // Render series
                    const seriesToRender = instructorMatches ? instructor.series : matchingSeries;
                    for (const series of seriesToRender) {
                        const seriesEl = seriesContainer.createEl('div', { cls: 'series-item' });
                        seriesEl.style.cssText = 'margin: 5px 0; padding: 5px; border-left: 2px solid var(--background-modifier-border);';

                        // Series header
                        const seriesHeader = seriesEl.createEl('div', { cls: 'series-header' });
                        seriesHeader.style.cssText = 'display: flex; align-items: center; gap: 5px;';

                        const seriesCheckbox = seriesHeader.createEl('input', { type: 'checkbox' });
                        seriesHeader.createEl('span', { text: `${series.name} (${series.video_count})` });

                        // Individual videos
                        const videosEl = seriesEl.createEl('div', { cls: 'videos-list' });
                        videosEl.style.cssText = 'margin-left: 20px; font-size: 0.9em;';

                        const videoCheckboxes: HTMLInputElement[] = [];

                        for (const video of series.videos) {
                            const videoEl = videosEl.createEl('div', { cls: 'video-item' });
                            videoEl.style.cssText = 'display: flex; align-items: center; gap: 5px; padding: 2px 0;';

                            const videoCheckbox = videoEl.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                            videoCheckbox.dataset.videoId = video.video_id;
                            videoCheckboxes.push(videoCheckbox);

                            if (this.selectedVideos.has(video.video_id)) {
                                videoCheckbox.checked = true;
                            }

                            videoCheckbox.addEventListener('change', () => {
                                if (videoCheckbox.checked) {
                                    this.selectedVideos.add(video.video_id);
                                } else {
                                    this.selectedVideos.delete(video.video_id);
                                }
                                updateSelectedCount();
                            });

                            const volText = video.volume ? ` (Vol ${video.volume})` : '';
                            videoEl.createEl('span', { text: video.title + volText });
                        }

                        // Series checkbox selects all videos in series
                        seriesCheckbox.addEventListener('change', () => {
                            for (const cb of videoCheckboxes) {
                                cb.checked = seriesCheckbox.checked;
                                if (seriesCheckbox.checked) {
                                    this.selectedVideos.add(cb.dataset.videoId!);
                                } else {
                                    this.selectedVideos.delete(cb.dataset.videoId!);
                                }
                            }
                            updateSelectedCount();
                        });
                    }

                    // Instructor checkbox selects all series
                    instructorCheckbox.addEventListener('change', () => {
                        const allCheckboxes = seriesContainer.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
                        allCheckboxes.forEach(cb => {
                            cb.checked = instructorCheckbox.checked;
                            if (cb.dataset.videoId) {
                                if (instructorCheckbox.checked) {
                                    this.selectedVideos.add(cb.dataset.videoId);
                                } else {
                                    this.selectedVideos.delete(cb.dataset.videoId);
                                }
                            }
                        });
                        updateSelectedCount();
                    });
                }
            };

            renderCatalog();

            // Filter handler
            searchEl.addEventListener('input', () => {
                renderCatalog(searchEl.value);
            });

            // Footer
            const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
            footerEl.style.cssText = 'margin-top: 15px; display: flex; gap: 10px; justify-content: flex-end;';

            new Setting(footerEl)
                .addButton(btn => btn
                    .setButtonText('Run Cross-Reference')
                    .setCta()
                    .onClick(async () => {
                        if (this.selectedVideos.size === 0) {
                            new Notice('Select at least one video to cross-reference');
                            return;
                        }

                        btn.setButtonText('Researching...');
                        btn.setDisabled(true);

                        try {
                            const response = await requestUrl({
                                url: `${this.plugin.settings.serverUrl}/api/obsidian/cross-reference`,
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                                },
                                body: JSON.stringify({
                                    concept: this.concept,
                                    concept_context: this.conceptContext,
                                    video_ids: Array.from(this.selectedVideos)
                                })
                            });

                            const data = response.json;

                            if (data.error) {
                                new Notice(`Error: ${data.error}`);
                                btn.setButtonText('Run Cross-Reference');
                                btn.setDisabled(false);
                                return;
                            }

                            // Show results in new modal
                            this.close();
                            const resultsModal = new CrossReferenceResultsModal(
                                this.app,
                                this.plugin,
                                data,
                                this.sourceFile
                            );
                            resultsModal.open();

                        } catch (error: any) {
                            new Notice(`Failed: ${error.message}`);
                            btn.setButtonText('Run Cross-Reference');
                            btn.setDisabled(false);
                        }
                    }))
                .addButton(btn => btn
                    .setButtonText('Cancel')
                    .onClick(() => this.close()));

        } catch (error: any) {
            loadingEl.textContent = `Failed to load catalog: ${error.message}`;
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Cross-Reference Results Modal
class CrossReferenceResultsModal extends Modal {
    plugin: BJJFlipmodePlugin;
    resultsData: any;
    sourceFile: TFile;

    constructor(app: App, plugin: BJJFlipmodePlugin, resultsData: any, sourceFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.resultsData = resultsData;
        this.sourceFile = sourceFile;
    }

    onOpen() {
        const { contentEl } = this;
        const { resultsData } = this;

        // Header
        contentEl.createEl('h2', { text: '📊 Cross-Reference Results' });

        // Stats
        const statsEl = contentEl.createEl('div', { cls: 'results-stats' });
        statsEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-secondary); border-radius: 5px;';
        statsEl.createEl('p', { text: `Concept: "${resultsData.concept}"` });
        statsEl.createEl('p', { text: `📹 ${resultsData.videos_analyzed} videos analyzed` });
        statsEl.createEl('p', { text: `🧠 ${resultsData.thinkers_used} thinker perspectives used` });

        // Sources used
        const sourcesEl = contentEl.createEl('div', { cls: 'sources-used' });
        sourcesEl.style.cssText = 'margin-bottom: 15px;';
        sourcesEl.createEl('h4', { text: 'Sources Cross-Referenced:' });
        const sourcesList = sourcesEl.createEl('ul');
        for (const src of resultsData.sources) {
            sourcesList.createEl('li', { text: `${src.instructor} - ${src.video_name}` });
        }

        // Research content
        const researchEl = contentEl.createEl('div', { cls: 'research-content' });
        researchEl.style.cssText = 'max-height: 400px; overflow-y: auto; padding: 15px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 5px; white-space: pre-wrap; font-family: var(--font-text);';
        researchEl.textContent = resultsData.research;

        // Footer
        const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
        footerEl.style.cssText = 'margin-top: 15px; display: flex; gap: 10px;';

        new Setting(footerEl)
            .addButton(btn => btn
                .setButtonText('Save to Note')
                .setCta()
                .onClick(async () => {
                    // Save as a new note
                    const fileName = `Cross-Reference - ${resultsData.concept.substring(0, 30)}.md`;
                    const folderPath = this.sourceFile.parent?.path || this.plugin.settings.syncFolder;
                    const filePath = `${folderPath}/${fileName}`;

                    const content = `---
type: cross-reference
concept: "${resultsData.concept}"
videos_analyzed: ${resultsData.videos_analyzed}
thinkers_used: ${resultsData.thinkers_used}
date: ${new Date().toISOString().split('T')[0]}
---

# Cross-Reference: ${resultsData.concept}

## Sources Analyzed
${resultsData.sources.map((s: any) => `- ${s.instructor} - ${s.video_name}`).join('\n')}

## Research

${resultsData.research}
`;

                    try {
                        await this.app.vault.create(filePath, content);
                        new Notice(`Saved to ${fileName}`);
                        this.close();

                        // Open the new file
                        const newFile = this.app.vault.getAbstractFileByPath(filePath);
                        if (newFile instanceof TFile) {
                            await this.app.workspace.getLeaf().openFile(newFile);
                        }
                    } catch (error: any) {
                        new Notice(`Failed to save: ${error.message}`);
                    }
                }))
            .addButton(btn => btn
                .setButtonText('Copy to Clipboard')
                .onClick(async () => {
                    await navigator.clipboard.writeText(resultsData.research);
                    new Notice('Copied to clipboard!');
                }))
            .addButton(btn => btn
                .setButtonText('Close')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Enrich Checkpoint Modal - RLM feedback loop for knowledge graph refinement
class EnrichCheckpointModal extends Modal {
    plugin: BJJFlipmodePlugin;
    checkpointData: {
        name: string;
        cluster: string;
        currentInvariables: string[];
        currentVariables: string[];
        goal: string;
        successTest: string;
    };
    sourceFile: TFile;
    selectedVideos: Set<string> = new Set();
    catalogData: any = null;

    constructor(app: App, plugin: BJJFlipmodePlugin, checkpointData: any, sourceFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.checkpointData = checkpointData;
        this.sourceFile = sourceFile;
    }

    async onOpen() {
        const { contentEl } = this;
        const { checkpointData } = this;

        // Header
        contentEl.createEl('h2', { text: 'RLM Checkpoint Enrichment' });

        // Checkpoint info
        const infoEl = contentEl.createEl('div', { cls: 'checkpoint-info' });
        infoEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-secondary); border-radius: 5px; border-left: 3px solid var(--text-accent);';
        infoEl.createEl('h3', { text: checkpointData.name });
        infoEl.createEl('p', { text: `Cluster: ${checkpointData.cluster}` });

        // Current state
        const currentEl = contentEl.createEl('div', { cls: 'current-state' });
        currentEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-primary-alt); border-radius: 5px;';
        currentEl.createEl('h4', { text: 'Current Knowledge:' });

        const invariablesEl = currentEl.createEl('div');
        invariablesEl.createEl('strong', { text: 'Invariables: ' });
        invariablesEl.createEl('span', {
            text: checkpointData.currentInvariables.length > 0
                ? checkpointData.currentInvariables.join(', ')
                : '(none)'
        });

        const variablesEl = currentEl.createEl('div');
        variablesEl.createEl('strong', { text: 'Variables: ' });
        variablesEl.createEl('span', {
            text: checkpointData.currentVariables.length > 0
                ? checkpointData.currentVariables.length + ' IF/THEN branches'
                : '(none)'
        });

        // Loading catalog
        const loadingEl = contentEl.createEl('div', { text: 'Loading video catalog...' });
        loadingEl.style.cssText = 'padding: 20px; text-align: center;';

        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/obsidian/catalog`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.plugin.settings.apiToken}` }
            });
            this.catalogData = response.json;
            loadingEl.remove();

            // Instructions
            contentEl.createEl('p', {
                text: `Select videos to analyze for enrichment (${this.catalogData.total_videos} available):`,
                cls: 'enrich-instructions'
            });

            // Selected count
            const selectedCountEl = contentEl.createEl('div', { cls: 'selected-count' });
            selectedCountEl.style.cssText = 'margin-bottom: 10px; font-weight: bold; color: var(--text-accent);';
            selectedCountEl.textContent = '0 videos selected';

            const updateCount = () => {
                selectedCountEl.textContent = `${this.selectedVideos.size} videos selected`;
            };

            // Search filter
            const searchEl = contentEl.createEl('input', { type: 'text', placeholder: 'Filter instructors/series...' });
            searchEl.style.cssText = 'width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 5px; border: 1px solid var(--background-modifier-border);';

            // Catalog list (compact version)
            const listEl = contentEl.createEl('div', { cls: 'catalog-list' });
            listEl.style.cssText = 'max-height: 250px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 5px; padding: 10px;';

            const renderCatalog = (filter: string = '') => {
                listEl.empty();
                const filterLower = filter.toLowerCase();

                for (const instructor of this.catalogData.instructors) {
                    const instructorMatches = instructor.name.toLowerCase().includes(filterLower);
                    const matchingSeries = instructor.series.filter((s: any) =>
                        instructorMatches || s.name.toLowerCase().includes(filterLower)
                    );

                    if (matchingSeries.length === 0 && !instructorMatches) continue;

                    const groupEl = listEl.createEl('div', { cls: 'instructor-group' });
                    groupEl.style.cssText = 'margin-bottom: 8px;';

                    const headerEl = groupEl.createEl('div', { cls: 'instructor-header' });
                    headerEl.style.cssText = 'display: flex; align-items: center; gap: 5px; cursor: pointer; padding: 3px; background: var(--background-secondary); border-radius: 3px;';

                    const expandIcon = headerEl.createEl('span', { text: '▶' });
                    expandIcon.style.cssText = 'font-size: 0.7em;';

                    const instructorCb = headerEl.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                    headerEl.createEl('span', { text: `${instructor.name} (${instructor.video_count})` });

                    const seriesContainer = groupEl.createEl('div');
                    seriesContainer.style.cssText = 'display: none; margin-left: 15px; font-size: 0.9em;';

                    headerEl.addEventListener('click', (e) => {
                        if (e.target === instructorCb) return;
                        const isExpanded = seriesContainer.style.display !== 'none';
                        seriesContainer.style.display = isExpanded ? 'none' : 'block';
                        expandIcon.style.transform = isExpanded ? '' : 'rotate(90deg)';
                    });

                    const allVideoIds: string[] = [];
                    const seriesToRender = instructorMatches ? instructor.series : matchingSeries;

                    for (const series of seriesToRender) {
                        const seriesEl = seriesContainer.createEl('div');
                        seriesEl.style.cssText = 'display: flex; align-items: center; gap: 5px; padding: 2px 0;';

                        const seriesCb = seriesEl.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                        seriesEl.createEl('span', { text: `${series.name} (${series.video_count})` });

                        const videoIds = series.videos.map((v: any) => v.video_id);
                        allVideoIds.push(...videoIds);

                        // Check if already selected
                        const allSelected = videoIds.every((id: string) => this.selectedVideos.has(id));
                        seriesCb.checked = allSelected;

                        seriesCb.addEventListener('change', () => {
                            for (const id of videoIds) {
                                if (seriesCb.checked) {
                                    this.selectedVideos.add(id);
                                } else {
                                    this.selectedVideos.delete(id);
                                }
                            }
                            updateCount();
                        });
                    }

                    instructorCb.addEventListener('change', () => {
                        const checkboxes = seriesContainer.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
                        checkboxes.forEach(cb => cb.checked = instructorCb.checked);
                        for (const id of allVideoIds) {
                            if (instructorCb.checked) {
                                this.selectedVideos.add(id);
                            } else {
                                this.selectedVideos.delete(id);
                            }
                        }
                        updateCount();
                    });
                }
            };

            renderCatalog();
            searchEl.addEventListener('input', () => renderCatalog(searchEl.value));

            // Footer
            const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
            footerEl.style.cssText = 'margin-top: 15px; display: flex; gap: 10px; justify-content: flex-end;';

            new Setting(footerEl)
                .addButton(btn => btn
                    .setButtonText('Run Enrichment')
                    .setCta()
                    .onClick(async () => {
                        if (this.selectedVideos.size === 0) {
                            new Notice('Select at least one video');
                            return;
                        }

                        btn.setButtonText('Analyzing...');
                        btn.setDisabled(true);

                        try {
                            const response = await requestUrl({
                                url: `${this.plugin.settings.serverUrl}/api/obsidian/enrich-checkpoint`,
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                                },
                                body: JSON.stringify({
                                    checkpoint_name: checkpointData.name,
                                    checkpoint_cluster: checkpointData.cluster,
                                    current_invariables: checkpointData.currentInvariables,
                                    current_variables: checkpointData.currentVariables,
                                    goal: checkpointData.goal,
                                    success_test: checkpointData.successTest,
                                    video_ids: Array.from(this.selectedVideos)
                                })
                            });

                            const enrichments = response.json;

                            if (enrichments.error) {
                                new Notice(`Error: ${enrichments.error}`);
                                btn.setButtonText('Run Enrichment');
                                btn.setDisabled(false);
                                return;
                            }

                            // Show enrichment results
                            this.close();
                            const resultsModal = new EnrichmentResultsModal(
                                this.app,
                                this.plugin,
                                enrichments,
                                this.sourceFile,
                                checkpointData
                            );
                            resultsModal.open();

                        } catch (error: any) {
                            new Notice(`Failed: ${error.message}`);
                            btn.setButtonText('Run Enrichment');
                            btn.setDisabled(false);
                        }
                    }))
                .addButton(btn => btn
                    .setButtonText('Cancel')
                    .onClick(() => this.close()));

        } catch (error: any) {
            loadingEl.textContent = `Failed to load catalog: ${error.message}`;
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Enrichment Results Modal - Shows proposed enrichments with accept/reject
class EnrichmentResultsModal extends Modal {
    plugin: BJJFlipmodePlugin;
    enrichments: any;
    sourceFile: TFile;
    checkpointData: any;
    acceptedInvariables: Set<number> = new Set();
    acceptedVariables: Set<number> = new Set();

    constructor(app: App, plugin: BJJFlipmodePlugin, enrichments: any, sourceFile: TFile, checkpointData: any) {
        super(app);
        this.plugin = plugin;
        this.enrichments = enrichments;
        this.sourceFile = sourceFile;
        this.checkpointData = checkpointData;
    }

    onOpen() {
        const { contentEl } = this;
        const { enrichments } = this;

        // Header
        contentEl.createEl('h2', { text: 'Enrichment Results' });

        // Stats
        const statsEl = contentEl.createEl('div', { cls: 'enrichment-stats' });
        statsEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-secondary); border-radius: 5px;';
        statsEl.createEl('p', { text: `Checkpoint: ${enrichments.checkpoint_name}` });
        statsEl.createEl('p', { text: `📹 ${enrichments.sources_analyzed} videos analyzed` });

        // Scrollable content
        const scrollEl = contentEl.createEl('div', { cls: 'enrichment-scroll' });
        scrollEl.style.cssText = 'max-height: 400px; overflow-y: auto;';

        // New Invariables
        if (enrichments.new_invariables && enrichments.new_invariables.length > 0) {
            const invSection = scrollEl.createEl('div', { cls: 'invariables-section' });
            invSection.createEl('h3', { text: `New Invariables (${enrichments.new_invariables.length})` });

            enrichments.new_invariables.forEach((inv: any, idx: number) => {
                const itemEl = invSection.createEl('div', { cls: 'enrichment-item' });
                itemEl.style.cssText = 'padding: 10px; margin: 5px 0; border-radius: 5px; background: var(--background-primary-alt); border-left: 3px solid var(--text-success);';

                const headerRow = itemEl.createEl('div');
                headerRow.style.cssText = 'display: flex; align-items: center; gap: 10px;';

                const checkbox = headerRow.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                checkbox.checked = true;
                this.acceptedInvariables.add(idx);

                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.acceptedInvariables.add(idx);
                    } else {
                        this.acceptedInvariables.delete(idx);
                    }
                });

                const tierBadge = headerRow.createEl('span', { cls: 'tier-badge' });
                tierBadge.style.cssText = `padding: 2px 6px; border-radius: 3px; font-size: 0.8em; background: ${inv.tier === 'CRITICAL' ? 'var(--text-error)' : inv.tier === 'IMPORTANT' ? 'var(--text-warning)' : 'var(--text-muted)'}; color: white;`;
                tierBadge.textContent = inv.tier;

                headerRow.createEl('strong', { text: inv.name });

                if (inv.source_instructor) {
                    const sourceEl = itemEl.createEl('p');
                    sourceEl.style.cssText = 'margin: 5px 0; font-size: 0.85em; color: var(--text-accent);';
                    sourceEl.textContent = `Source: ${inv.source_instructor}${inv.timestamp ? ` [${inv.timestamp}]` : ''}`;
                }

                if (inv.description) {
                    const descEl = itemEl.createEl('p');
                    descEl.style.cssText = 'margin: 5px 0; font-size: 0.9em; color: var(--text-muted);';
                    descEl.textContent = inv.description;
                }
            });
        }

        // New Variables
        if (enrichments.new_variables && enrichments.new_variables.length > 0) {
            const varSection = scrollEl.createEl('div', { cls: 'variables-section' });
            varSection.style.cssText = 'margin-top: 15px;';
            varSection.createEl('h3', { text: `🔀 New Variables (${enrichments.new_variables.length})` });

            enrichments.new_variables.forEach((v: any, idx: number) => {
                const itemEl = varSection.createEl('div', { cls: 'enrichment-item' });
                itemEl.style.cssText = 'padding: 10px; margin: 5px 0; border-radius: 5px; background: var(--background-primary-alt); border-left: 3px solid var(--text-warning);';

                const headerRow = itemEl.createEl('div');
                headerRow.style.cssText = 'display: flex; align-items: center; gap: 10px;';

                const checkbox = headerRow.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                checkbox.checked = true;
                this.acceptedVariables.add(idx);

                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.acceptedVariables.add(idx);
                    } else {
                        this.acceptedVariables.delete(idx);
                    }
                });

                headerRow.createEl('strong', { text: `${v.condition} → ${v.action}` });

                if (v.source_instructor) {
                    const sourceEl = itemEl.createEl('p');
                    sourceEl.style.cssText = 'margin: 5px 0; font-size: 0.85em; color: var(--text-accent);';
                    sourceEl.textContent = `Source: ${v.source_instructor}${v.timestamp ? ` [${v.timestamp}]` : ''}`;
                }

                if (v.description) {
                    const descEl = itemEl.createEl('p');
                    descEl.style.cssText = 'margin: 5px 0; font-size: 0.9em; color: var(--text-muted);';
                    descEl.textContent = v.description;
                }
            });
        }

        // Defensive Inversions
        if (enrichments.defensive_inversions && enrichments.defensive_inversions.length > 0) {
            const invSection = scrollEl.createEl('div', { cls: 'inversions-section' });
            invSection.style.cssText = 'margin-top: 15px;';
            invSection.createEl('h3', { text: `Defensive Inversions (${enrichments.defensive_inversions.length})` });

            for (const inv of enrichments.defensive_inversions) {
                const itemEl = invSection.createEl('div', { cls: 'inversion-item' });
                itemEl.style.cssText = 'padding: 10px; margin: 5px 0; border-radius: 5px; background: var(--background-primary-alt); border-left: 3px solid var(--interactive-accent);';

                itemEl.createEl('p', { text: `Defender wants: ${inv.defensive_concept}` });
                itemEl.createEl('p', { text: `→ You should: ${inv.offensive_counter}` });
                if (inv.source_instructor) {
                    const srcEl = itemEl.createEl('p');
                    srcEl.style.cssText = 'font-size: 0.85em; color: var(--text-accent);';
                    srcEl.textContent = `Source: ${inv.source_instructor}`;
                }
            }
        }

        // Key Insights
        if (enrichments.key_insights && enrichments.key_insights.length > 0) {
            const insightsSection = scrollEl.createEl('div', { cls: 'insights-section' });
            insightsSection.style.cssText = 'margin-top: 15px;';
            insightsSection.createEl('h3', { text: `Key Insights` });

            const ul = insightsSection.createEl('ul');
            for (const insight of enrichments.key_insights) {
                ul.createEl('li', { text: insight });
            }
        }

        // Footer
        const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
        footerEl.style.cssText = 'margin-top: 15px; display: flex; gap: 10px; justify-content: flex-end;';

        new Setting(footerEl)
            .addButton(btn => btn
                .setButtonText('Apply Selected Enrichments')
                .setCta()
                .onClick(async () => {
                    await this.applyEnrichments();
                }))
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    async applyEnrichments() {
        const { enrichments, sourceFile, checkpointData } = this;

        try {
            // Read current file
            let content = await this.app.vault.read(sourceFile);

            // Get accepted invariables
            const newInvariables = enrichments.new_invariables?.filter((_: any, idx: number) =>
                this.acceptedInvariables.has(idx)
            ) || [];

            // Get accepted variables
            const newVariables = enrichments.new_variables?.filter((_: any, idx: number) =>
                this.acceptedVariables.has(idx)
            ) || [];

            if (newInvariables.length === 0 && newVariables.length === 0) {
                new Notice('No enrichments selected');
                return;
            }

            // Track created files for Canvas
            const createdFiles: TFile[] = [];

            // Add new invariables to the table (create method files with timestamps for WebM clips)
            if (newInvariables.length > 0) {
                const tableMatch = content.match(/(## INVARIABLES[\s\S]*?\| REFINEMENT \|[^\n]*)/);
                if (tableMatch) {
                    let newRows = '';
                    for (const inv of newInvariables) {
                        // Sanitize name for file path
                        const safeName = inv.name.replace(/[\\/:*?"<>|]/g, '-').substring(0, 60);
                        const conceptPath = `${sourceFile.parent?.path}/${safeName}.md`;

                        const conceptContent = `---
type: method
method_type: invariable
cluster: "${checkpointData.cluster}"
tier: "${inv.tier}"
source_instructor: "${inv.source_instructor || 'Unknown'}"
video_id: "${inv.video_id || ''}"
timestamp: "${inv.timestamp || ''}"
clip_duration: 30
enrichment_source: true
---

# ${inv.name}

${inv.description || ''}

## Clip Info
- **Instructor:** ${inv.source_instructor || 'Unknown'}
- **Timestamp:** ${inv.timestamp || 'N/A'}
- **Video ID:** ${inv.video_id || 'N/A'}
`;
                        const existingFile = this.app.vault.getAbstractFileByPath(conceptPath);
                        if (!existingFile) {
                            const newFile = await this.app.vault.create(conceptPath, conceptContent);
                            createdFiles.push(newFile);
                        }

                        const linkText = `[[${safeName}]]`;
                        newRows += `| ${inv.tier} | ${linkText} |\n`;
                    }

                    const refinementMatch = content.match(/(\| REFINEMENT \|[^\n]*\n)/);
                    if (refinementMatch) {
                        content = content.replace(refinementMatch[1], newRows + refinementMatch[1]);
                    }
                }
            }

            // Add new variables (also create method files for IF/THEN branches)
            if (newVariables.length > 0) {
                const variablesMatch = content.match(/(## VARIABLES \(IF\/THEN\)\n\n)([\s\S]*?)(\n---)/);
                if (variablesMatch) {
                    let newVarText = '';
                    for (const v of newVariables) {
                        // Create a method file for the variable
                        const safeName = v.condition.replace(/^IF\s*/i, '').replace(/[\\/:*?"<>|]/g, '-').substring(0, 50);
                        const varPath = `${sourceFile.parent?.path}/VAR - ${safeName}.md`;

                        const varContent = `---
type: method
method_type: variable
cluster: "${checkpointData.cluster}"
condition: "${v.condition}"
action: "${v.action}"
source_instructor: "${v.source_instructor || 'Unknown'}"
video_id: "${v.video_id || ''}"
timestamp: "${v.timestamp || ''}"
clip_duration: 30
enrichment_source: true
---

# ${v.condition}

**Action:** ${v.action}

${v.description || ''}

## Clip Info
- **Instructor:** ${v.source_instructor || 'Unknown'}
- **Timestamp:** ${v.timestamp || 'N/A'}
- **Video ID:** ${v.video_id || 'N/A'}
`;
                        const existingVarFile = this.app.vault.getAbstractFileByPath(varPath);
                        if (!existingVarFile) {
                            const newVarFile = await this.app.vault.create(varPath, varContent);
                            createdFiles.push(newVarFile);
                        }

                        newVarText += `- **${v.condition}** → ${v.action} → [[VAR - ${safeName}]]\n`;
                    }
                    content = content.replace(
                        variablesMatch[0],
                        variablesMatch[1] + variablesMatch[2] + newVarText + variablesMatch[3]
                    );
                }
            }

            // Add enrichment metadata to frontmatter (remove old entries first to avoid duplicates)
            const enrichmentDate = new Date().toISOString().split('T')[0];

            if (content.includes('---\n')) {
                const parts = content.split('---');
                if (parts.length >= 2) {
                    // Remove existing enrichment lines
                    parts[1] = parts[1]
                        .replace(/\nlast_enriched:.*$/gm, '')
                        .replace(/\nenrichment_sources:.*$/gm, '')
                        .trimEnd();
                    // Add fresh enrichment data
                    parts[1] += `\nlast_enriched: ${enrichmentDate}\nenrichment_sources: ${enrichments.sources_analyzed} videos\n`;
                    content = parts.join('---');
                }
            }

            // Save the file
            await this.app.vault.modify(sourceFile, content);

            // ========== ADD NODES TO CANVAS ==========
            // Find the active Canvas and add nodes for new concepts
            const canvasLeaves = this.app.workspace.getLeavesOfType('canvas');
            if (canvasLeaves.length > 0 && createdFiles.length > 0) {
                const canvasView = canvasLeaves[0].view as any;
                const canvas = canvasView?.canvas;

                if (canvas) {
                    // Find the checkpoint node in the canvas
                    let checkpointNode: any = null;
                    let checkpointX = 0;
                    let checkpointY = 0;

                    for (const node of canvas.nodes.values()) {
                        if (node.file?.path === sourceFile.path) {
                            checkpointNode = node;
                            checkpointX = node.x;
                            checkpointY = node.y;
                            break;
                        }
                    }

                    // Add new nodes arranged around the checkpoint
                    const nodeWidth = 250;
                    const nodeHeight = 100;
                    const spacing = 50;
                    const startX = checkpointX + 350; // To the right of checkpoint
                    let currentY = checkpointY - ((createdFiles.length - 1) * (nodeHeight + spacing)) / 2;

                    for (const file of createdFiles) {
                        // Create a file node on the canvas
                        const nodeData = {
                            id: `enrichment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                            type: 'file',
                            file: file.path,
                            x: startX,
                            y: currentY,
                            width: nodeWidth,
                            height: nodeHeight
                        };

                        canvas.createFileNode({
                            file: file,
                            pos: { x: startX, y: currentY },
                            size: { width: nodeWidth, height: nodeHeight }
                        });

                        currentY += nodeHeight + spacing;
                    }

                    // Request canvas save
                    canvas.requestSave();

                    new Notice(`Added ${createdFiles.length} nodes to Canvas`);
                }
            }

            new Notice(`Applied ${newInvariables.length} invariables and ${newVariables.length} variables`);

            this.close();

            // Refresh the file
            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(sourceFile);

        } catch (error: any) {
            new Notice(`Failed to apply enrichments: ${error.message}`);
            console.error('Apply enrichments error:', error);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// RLM Pipeline Modal - Single button: Backup → Enrich → Rebuild Canvas
class RLMPipelineModal extends Modal {
    plugin: BJJFlipmodePlugin;
    canvasFile: TFile;
    folder: TFolder;
    checkpointFiles: TFile[];
    selectedVideos: Set<string> = new Set();
    catalogData: any = null;

    constructor(app: App, plugin: BJJFlipmodePlugin, canvasFile: TFile, folder: TFolder, checkpointFiles: TFile[]) {
        super(app);
        this.plugin = plugin;
        this.canvasFile = canvasFile;
        this.folder = folder;
        this.checkpointFiles = checkpointFiles;
    }

    async onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'RLM Pipeline: Enrich & Rebuild' });

        // Pipeline steps
        const stepsEl = contentEl.createEl('div', { cls: 'pipeline-steps' });
        stepsEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-secondary); border-radius: 5px;';
        stepsEl.createEl('p', { text: 'This will:', cls: 'steps-header' });
        const stepsList = stepsEl.createEl('ol');
        stepsList.style.cssText = 'margin: 5px 0; padding-left: 25px; font-size: 0.9em;';
        stepsList.createEl('li', { text: 'Backup current canvas (version control)' });
        stepsList.createEl('li', { text: 'Enrich all checkpoints with selected videos' });
        stepsList.createEl('li', { text: 'Rebuild canvas with proper layout & connections' });

        // Show checkpoints found
        const infoEl = contentEl.createEl('div', { cls: 'checkpoint-info' });
        infoEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-primary-alt); border-radius: 5px;';
        infoEl.createEl('p', { text: `Found ${this.checkpointFiles.length} checkpoints in ${this.folder.name}:` });

        const checkpointList = infoEl.createEl('ul');
        checkpointList.style.cssText = 'margin: 5px 0; padding-left: 20px; font-size: 0.9em; max-height: 100px; overflow-y: auto;';
        for (const file of this.checkpointFiles) {
            checkpointList.createEl('li', { text: file.basename });
        }

        // Loading catalog
        const loadingEl = contentEl.createEl('div', { text: 'Loading video catalog...' });
        loadingEl.style.cssText = 'padding: 20px; text-align: center;';

        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/obsidian/catalog`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${this.plugin.settings.apiToken}` }
            });
            this.catalogData = response.json;
            loadingEl.remove();

            contentEl.createEl('p', {
                text: `Select videos to cross-reference ALL checkpoints (${this.catalogData.total_videos} available):`
            });

            // Selected count
            const selectedCountEl = contentEl.createEl('div', { cls: 'selected-count' });
            selectedCountEl.style.cssText = 'margin-bottom: 10px; font-weight: bold; color: var(--text-accent);';
            selectedCountEl.textContent = '0 videos selected';

            const updateCount = () => {
                selectedCountEl.textContent = `${this.selectedVideos.size} videos selected`;
            };

            // Search filter
            const searchEl = contentEl.createEl('input', { type: 'text', placeholder: 'Filter instructors/series...' });
            searchEl.style.cssText = 'width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 5px; border: 1px solid var(--background-modifier-border);';

            // Catalog list
            const listEl = contentEl.createEl('div', { cls: 'catalog-list' });
            listEl.style.cssText = 'max-height: 200px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 5px; padding: 10px;';

            const renderCatalog = (filter: string = '') => {
                listEl.empty();
                const filterLower = filter.toLowerCase();

                for (const instructor of this.catalogData.instructors) {
                    const instructorMatches = instructor.name.toLowerCase().includes(filterLower);
                    const matchingSeries = instructor.series.filter((s: any) =>
                        instructorMatches || s.name.toLowerCase().includes(filterLower)
                    );

                    if (matchingSeries.length === 0 && !instructorMatches) continue;

                    const groupEl = listEl.createEl('div', { cls: 'instructor-group' });
                    groupEl.style.cssText = 'margin-bottom: 8px;';

                    const headerEl = groupEl.createEl('div', { cls: 'instructor-header' });
                    headerEl.style.cssText = 'display: flex; align-items: center; gap: 5px; cursor: pointer; padding: 3px; background: var(--background-secondary); border-radius: 3px;';

                    const expandIcon = headerEl.createEl('span', { text: '>' });
                    expandIcon.style.cssText = 'font-size: 0.8em; width: 12px;';

                    const instructorCb = headerEl.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                    headerEl.createEl('span', { text: `${instructor.name} (${instructor.video_count})` });

                    const seriesContainer = groupEl.createEl('div');
                    seriesContainer.style.cssText = 'display: none; margin-left: 20px; font-size: 0.9em;';

                    headerEl.addEventListener('click', (e) => {
                        if (e.target === instructorCb) return;
                        const isExpanded = seriesContainer.style.display !== 'none';
                        seriesContainer.style.display = isExpanded ? 'none' : 'block';
                        expandIcon.textContent = isExpanded ? '>' : 'v';
                    });

                    const allVideoIds: string[] = [];
                    const seriesToRender = instructorMatches ? instructor.series : matchingSeries;

                    for (const series of seriesToRender) {
                        const seriesEl = seriesContainer.createEl('div');
                        seriesEl.style.cssText = 'display: flex; align-items: center; gap: 5px; padding: 2px 0;';

                        const seriesCb = seriesEl.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
                        seriesEl.createEl('span', { text: `${series.name} (${series.video_count})` });

                        const videoIds = series.videos.map((v: any) => v.video_id);
                        allVideoIds.push(...videoIds);

                        const allSelected = videoIds.every((id: string) => this.selectedVideos.has(id));
                        seriesCb.checked = allSelected;

                        seriesCb.addEventListener('change', () => {
                            for (const id of videoIds) {
                                if (seriesCb.checked) {
                                    this.selectedVideos.add(id);
                                } else {
                                    this.selectedVideos.delete(id);
                                }
                            }
                            updateCount();
                        });
                    }

                    instructorCb.addEventListener('change', () => {
                        const checkboxes = seriesContainer.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
                        checkboxes.forEach(cb => cb.checked = instructorCb.checked);
                        for (const id of allVideoIds) {
                            if (instructorCb.checked) {
                                this.selectedVideos.add(id);
                            } else {
                                this.selectedVideos.delete(id);
                            }
                        }
                        updateCount();
                    });
                }
            };

            renderCatalog();
            searchEl.addEventListener('input', () => renderCatalog(searchEl.value));

            // Progress area (hidden initially)
            const progressEl = contentEl.createEl('div', { cls: 'progress-area' });
            progressEl.style.cssText = 'display: none; margin-top: 15px; padding: 10px; background: var(--background-primary-alt); border-radius: 5px;';

            // Footer
            const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
            footerEl.style.cssText = 'margin-top: 15px; display: flex; gap: 10px; justify-content: flex-end;';

            new Setting(footerEl)
                .addButton(btn => btn
                    .setButtonText('Run RLM Pipeline')
                    .setCta()
                    .onClick(async () => {
                        if (this.selectedVideos.size === 0) {
                            new Notice('Select at least one video');
                            return;
                        }

                        btn.setButtonText('Running Pipeline...');
                        btn.setDisabled(true);

                        progressEl.style.display = 'block';
                        progressEl.empty();

                        // STEP 1: Backup Canvas
                        progressEl.createEl('h4', { text: 'Step 1: Backing up canvas...' });
                        const backupName = `${this.canvasFile.basename}_backup_${Date.now()}.canvas`;
                        const backupPath = `${this.folder.path}/${backupName}`;
                        try {
                            const canvasContent = await this.app.vault.read(this.canvasFile);
                            await this.app.vault.create(backupPath, canvasContent);
                            progressEl.createEl('p', { text: `Backup saved: ${backupName}` });
                        } catch (e) {
                            progressEl.createEl('p', { text: 'Backup failed, continuing...' });
                        }

                        // STEP 2: Enrich all checkpoints
                        progressEl.createEl('h4', { text: 'Step 2: Enriching checkpoints...' });

                        const videoIds = Array.from(this.selectedVideos);
                        let successCount = 0;
                        let totalNewConcepts = 0;

                        for (let i = 0; i < this.checkpointFiles.length; i++) {
                            const file = this.checkpointFiles[i];
                            const checkpointName = file.basename;

                            const statusEl = progressEl.createEl('div');
                            statusEl.textContent = `[${i + 1}/${this.checkpointFiles.length}] ${checkpointName}...`;

                            try {
                                // Parse checkpoint data
                                const content = await this.app.vault.read(file);
                                const cache = this.app.metadataCache.getFileCache(file);

                                const invariablesMatch = content.match(/## INVARIABLES[\s\S]*?\|[\s\S]*?\|([\s\S]*?)(?=\n---|\n##|$)/);
                                const currentInvariables: string[] = [];
                                if (invariablesMatch) {
                                    const links = invariablesMatch[1].match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g) || [];
                                    for (const link of links) {
                                        const nameMatch = link.match(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/);
                                        if (nameMatch && nameMatch[1] !== 'none') {
                                            currentInvariables.push(nameMatch[1].trim());
                                        }
                                    }
                                }

                                const variablesMatch = content.match(/## VARIABLES[\s\S]*?((?:- \*\*IF.*\n?)+)/);
                                const currentVariables: string[] = [];
                                if (variablesMatch) {
                                    const lines = variablesMatch[1].match(/- \*\*IF[^*]+\*\*[^\n]+/g) || [];
                                    currentVariables.push(...lines.map(l => l.replace(/^- /, '').trim()));
                                }

                                const goalMatch = content.match(/## Goal\n\n([^\n]+)/);
                                const goal = goalMatch ? goalMatch[1].trim() : '';

                                const successMatch = content.match(/## Success Test\n\n> ([^\n]+)/);
                                const successTest = successMatch ? successMatch[1].trim() : '';

                                // Call enrichment API
                                const response = await requestUrl({
                                    url: `${this.plugin.settings.serverUrl}/api/obsidian/enrich-checkpoint`,
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                                    },
                                    body: JSON.stringify({
                                        checkpoint_name: checkpointName,
                                        checkpoint_cluster: cache?.frontmatter?.cluster || '',
                                        current_invariables: currentInvariables,
                                        current_variables: currentVariables,
                                        goal,
                                        success_test: successTest,
                                        video_ids: videoIds
                                    }),
                                    throw: false
                                });

                                if (response.status === 200) {
                                    const enrichments = response.json;
                                    const newCount = (enrichments.new_invariables?.length || 0) + (enrichments.new_variables?.length || 0);
                                    totalNewConcepts += newCount;

                                    // Auto-apply enrichments to markdown files
                                    if (newCount > 0) {
                                        await this.applyEnrichmentsToCheckpoint(file, enrichments);
                                    }

                                    statusEl.textContent = `[${i + 1}/${this.checkpointFiles.length}] ${checkpointName} - ${newCount} new concepts`;
                                    statusEl.style.color = 'var(--text-success)';
                                    successCount++;
                                } else {
                                    statusEl.textContent = `[${i + 1}/${this.checkpointFiles.length}] ${checkpointName} - Failed`;
                                    statusEl.style.color = 'var(--text-error)';
                                }
                            } catch (error: any) {
                                statusEl.textContent = `[${i + 1}/${this.checkpointFiles.length}] ${checkpointName} - Error: ${error.message}`;
                                statusEl.style.color = 'var(--text-error)';
                            }
                        }

                        // STEP 3: Rebuild canvas
                        progressEl.createEl('hr');
                        progressEl.createEl('h4', { text: 'Step 3: Rebuilding canvas...' });

                        const rebuildStatus = progressEl.createEl('div');
                        rebuildStatus.textContent = 'Scanning checkpoint files and linked concepts...';

                        try {
                            const newCanvasPath = await this.rebuildCanvasForFolder(this.folder, this.canvasFile.basename);
                            rebuildStatus.textContent = `Canvas rebuilt: ${newCanvasPath}`;
                            rebuildStatus.style.color = 'var(--text-success)';
                        } catch (err: any) {
                            rebuildStatus.textContent = `Canvas rebuild failed: ${err.message}`;
                            rebuildStatus.style.color = 'var(--text-error)';
                        }

                        // Summary
                        progressEl.createEl('hr');
                        progressEl.createEl('p', {
                            text: `Complete: ${successCount}/${this.checkpointFiles.length} checkpoints enriched, ${totalNewConcepts} new concepts added`
                        });

                        btn.setButtonText('Done');
                        btn.setDisabled(false);
                        btn.buttonEl.onclick = () => this.close();
                        new Notice(`RLM Pipeline complete: ${totalNewConcepts} new concepts, canvas rebuilt`);
                    }))
                .addButton(btn => btn
                    .setButtonText('Cancel')
                    .onClick(() => this.close()));

        } catch (error: any) {
            loadingEl.textContent = `Error loading catalog: ${error.message}`;
        }
    }

    async applyEnrichmentsToCheckpoint(file: TFile, enrichments: any) {
        const cache = this.app.metadataCache.getFileCache(file);
        const cluster = cache?.frontmatter?.cluster || '';

        let content = await this.app.vault.read(file);

        // Add new invariables (create concept files with timestamps for WebM clips)
        if (enrichments.new_invariables?.length > 0) {
            const tableMatch = content.match(/(## INVARIABLES[\s\S]*?\| REFINEMENT \|[^\n]*)/);
            if (tableMatch) {
                let newRows = '';
                for (const inv of enrichments.new_invariables) {
                    // Sanitize name for file path
                    const safeName = inv.name.replace(/[\\/:*?"<>|]/g, '-').substring(0, 60);
                    const conceptPath = `${file.parent?.path}/${safeName}.md`;

                    const conceptContent = `---
type: method
method_type: invariable
cluster: "${cluster}"
tier: "${inv.tier}"
source_instructor: "${inv.source_instructor || 'Unknown'}"
video_id: "${inv.video_id || ''}"
timestamp: "${inv.timestamp || ''}"
clip_duration: 30
enrichment_source: true
---

# ${inv.name}

${inv.description || ''}

## Clip Info
- **Instructor:** ${inv.source_instructor || 'Unknown'}
- **Timestamp:** ${inv.timestamp || 'N/A'}
- **Video ID:** ${inv.video_id || 'N/A'}
`;
                    const existingFile = this.app.vault.getAbstractFileByPath(conceptPath);
                    if (!existingFile) {
                        await this.app.vault.create(conceptPath, conceptContent);
                    }

                    const linkText = `[[${safeName}]]`;
                    newRows += `| ${inv.tier} | ${linkText} |\n`;
                }

                const refinementMatch = content.match(/(\| REFINEMENT \|[^\n]*\n)/);
                if (refinementMatch) {
                    content = content.replace(refinementMatch[1], newRows + refinementMatch[1]);
                }
            }
        }

        // Add new variables (also create method files for IF/THEN branches)
        if (enrichments.new_variables?.length > 0) {
            const variablesMatch = content.match(/(## VARIABLES \(IF\/THEN\)\n\n)([\s\S]*?)(\n---)/);
            if (variablesMatch) {
                let newVarText = '';
                for (const v of enrichments.new_variables) {
                    // Create a method file for the variable too
                    const safeName = v.condition.replace(/^IF\s*/i, '').replace(/[\\/:*?"<>|]/g, '-').substring(0, 50);
                    const varPath = `${file.parent?.path}/VAR - ${safeName}.md`;

                    const varContent = `---
type: method
method_type: variable
cluster: "${cluster}"
condition: "${v.condition}"
action: "${v.action}"
source_instructor: "${v.source_instructor || 'Unknown'}"
video_id: "${v.video_id || ''}"
timestamp: "${v.timestamp || ''}"
clip_duration: 30
enrichment_source: true
---

# ${v.condition}

**Action:** ${v.action}

${v.description || ''}

## Clip Info
- **Instructor:** ${v.source_instructor || 'Unknown'}
- **Timestamp:** ${v.timestamp || 'N/A'}
- **Video ID:** ${v.video_id || 'N/A'}
`;
                    const existingVarFile = this.app.vault.getAbstractFileByPath(varPath);
                    if (!existingVarFile) {
                        await this.app.vault.create(varPath, varContent);
                    }

                    newVarText += `- **${v.condition}** → ${v.action} → [[VAR - ${safeName}]]\n`;
                }
                content = content.replace(
                    variablesMatch[0],
                    variablesMatch[1] + variablesMatch[2] + newVarText + variablesMatch[3]
                );
            }
        }

        // Add metadata (remove old entries first to avoid duplicates)
        const enrichmentDate = new Date().toISOString().split('T')[0];

        if (content.includes('---\n')) {
            const parts = content.split('---');
            if (parts.length >= 2) {
                // Remove existing enrichment lines
                parts[1] = parts[1]
                    .replace(/\nlast_enriched:.*$/gm, '')
                    .replace(/\nenrichment_sources:.*$/gm, '')
                    .trimEnd();
                // Add fresh enrichment data
                parts[1] += `\nlast_enriched: ${enrichmentDate}\nenrichment_sources: ${enrichments.sources_analyzed} videos\n`;
                content = parts.join('---');
            }
        }

        await this.app.vault.modify(file, content);
    }

    /**
     * Rebuild canvas from checkpoints in a folder.
     * Creates a new canvas with proper layout and connections.
     */
    async rebuildCanvasForFolder(folder: TFolder, canvasBasename: string): Promise<string> {
        // Find all checkpoint and method files in the folder
        const checkpoints: any[] = [];
        const methods: any[] = [];

        for (const file of this.app.vault.getFiles()) {
            // Must be markdown in same folder
            if (file.extension !== 'md') continue;
            if (file.parent?.path !== folder.path) continue;

            const cache = this.app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter;

            if (frontmatter?.type === 'checkpoint') {
                const content = await this.app.vault.read(file);
                const order = frontmatter?.order || parseInt(file.basename.match(/\[(\d+)\]/)?.[1] || '99');

                // Extract linked invariables
                const invariables: string[] = [];
                const invMatch = content.match(/## INVARIABLES[\s\S]*?\|([\s\S]*?)(?=\n##|\n---)/);
                if (invMatch) {
                    const links = invMatch[1].match(/\[\[([^\]|]+)/g) || [];
                    for (const link of links) {
                        const name = link.replace('[[', '').trim();
                        if (name && name !== 'none') {
                            invariables.push(name);
                        }
                    }
                }

                // Extract navigation links
                const navigation: string[] = [];
                const navMatch = content.match(/## Navigation[\s\S]*?((?:\[\[[^\]]+\]\][^\n]*\n?)+)/);
                if (navMatch) {
                    const navLinks = navMatch[1].match(/\[\[([^\]|]+)/g) || [];
                    for (const link of navLinks) {
                        navigation.push(link.replace('[[', '').trim());
                    }
                }

                checkpoints.push({
                    file,
                    order,
                    cluster: frontmatter?.cluster || '',
                    invariables,
                    navigation
                });
            } else if (frontmatter?.type === 'method' || frontmatter?.type === 'concept' || frontmatter?.method_type) {
                // Method/concept files - used to connect to checkpoints
                methods.push({
                    file,
                    tier: frontmatter?.tier || frontmatter?.method_type || 'REFINEMENT',
                    cluster: frontmatter?.cluster || ''
                });
            }
        }

        if (checkpoints.length === 0) {
            throw new Error('No checkpoint files found');
        }

        // Sort checkpoints by order
        checkpoints.sort((a, b) => a.order - b.order);

        // Build canvas JSON
        const canvasData: any = { nodes: [], edges: [] };

        const checkpointWidth = 300;
        const checkpointHeight = 150;
        const methodWidth = 200;
        const methodHeight = 80;
        const horizontalGap = 400;
        const methodOffsetX = 350;
        const methodGap = 100;

        let currentX = 100;
        const checkpointY = 300;
        const nodeIdMap: Map<string, string> = new Map();

        for (let i = 0; i < checkpoints.length; i++) {
            const cp = checkpoints[i];
            const nodeId = `checkpoint-${i}`;
            nodeIdMap.set(cp.file.basename, nodeId);

            canvasData.nodes.push({
                id: nodeId,
                type: 'file',
                file: cp.file.path,
                x: currentX,
                y: checkpointY,
                width: checkpointWidth,
                height: checkpointHeight,
                color: '4'
            });

            // Add method nodes for invariables
            let methodY = checkpointY - methodGap - methodHeight;
            for (const invName of cp.invariables) {
                const methodFile = methods.find(m => m.file.basename === invName);
                if (methodFile) {
                    const methodId = `method-${nodeIdMap.size}`;
                    nodeIdMap.set(invName, methodId);

                    // Determine color based on tier
                    let color = '0';
                    if (methodFile.tier === 'CRITICAL') color = '1';
                    else if (methodFile.tier === 'IMPORTANT') color = '6';
                    else if (methodFile.tier === 'invariable') color = '5';

                    canvasData.nodes.push({
                        id: methodId,
                        type: 'file',
                        file: methodFile.file.path,
                        x: currentX + methodOffsetX,
                        y: methodY,
                        width: methodWidth,
                        height: methodHeight,
                        color
                    });

                    canvasData.edges.push({
                        id: `edge-${canvasData.edges.length}`,
                        fromNode: nodeId,
                        fromSide: 'right',
                        toNode: methodId,
                        toSide: 'left'
                    });

                    methodY -= methodHeight + 30;
                }
            }

            // Edge to next checkpoint
            if (i < checkpoints.length - 1) {
                canvasData.edges.push({
                    id: `edge-cp-${i}`,
                    fromNode: nodeId,
                    fromSide: 'right',
                    toNode: `checkpoint-${i + 1}`,
                    toSide: 'left',
                    color: '5'
                });
            }

            currentX += horizontalGap;
        }

        // Add navigation edges
        for (const cp of checkpoints) {
            const fromId = nodeIdMap.get(cp.file.basename);
            for (const navTarget of cp.navigation) {
                const toId = nodeIdMap.get(navTarget);
                if (fromId && toId && fromId !== toId) {
                    const exists = canvasData.edges.some((e: any) =>
                        e.fromNode === fromId && e.toNode === toId
                    );
                    if (!exists) {
                        canvasData.edges.push({
                            id: `edge-nav-${canvasData.edges.length}`,
                            fromNode: fromId,
                            fromSide: 'bottom',
                            toNode: toId,
                            toSide: 'top',
                            color: '3'
                        });
                    }
                }
            }
        }

        // Write canvas file
        const canvasPath = `${folder.path}/${canvasBasename} - RLM.canvas`;
        const canvasContent = JSON.stringify(canvasData, null, 2);

        const existingCanvas = this.app.vault.getAbstractFileByPath(canvasPath);
        if (existingCanvas) {
            await this.app.vault.modify(existingCanvas as TFile, canvasContent);
        } else {
            await this.app.vault.create(canvasPath, canvasContent);
        }

        // Open the new canvas
        const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
        if (canvasFile) {
            await this.app.workspace.getLeaf().openFile(canvasFile as TFile);
        }

        return canvasPath;
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Clip Browser Modal - Shows clip options with summaries from transcription
class ClipBrowserModal extends Modal {
    plugin: BJJFlipmodePlugin;
    sourceFile: TFile;
    clipData: any;

    constructor(app: App, plugin: BJJFlipmodePlugin, sourceFile: TFile, clipData: any) {
        super(app);
        this.plugin = plugin;
        this.sourceFile = sourceFile;
        this.clipData = clipData;
    }

    onOpen() {
        const { contentEl } = this;
        const { clipData, sourceFile } = this;

        contentEl.createEl('h2', { text: `Clip Options: ${sourceFile.basename}` });

        // Video info
        const infoEl = contentEl.createEl('div', { cls: 'clip-info' });
        infoEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: var(--background-secondary); border-radius: 5px;';
        infoEl.createEl('p', { text: `Video: ${clipData.video_name || clipData.video_id}` });
        infoEl.createEl('p', { text: `Instructor: ${clipData.instructor || 'Unknown'}` });
        infoEl.createEl('p', { text: `Found ${clipData.clips?.length || 0} relevant sections` });

        if (!clipData.clips || clipData.clips.length === 0) {
            contentEl.createEl('p', { text: 'No clip options found for this concept.' });
            return;
        }

        // Clip list
        const listEl = contentEl.createEl('div', { cls: 'clip-list' });
        listEl.style.cssText = 'max-height: 400px; overflow-y: auto;';

        for (const clip of clipData.clips) {
            const clipEl = listEl.createEl('div', { cls: 'clip-option' });
            clipEl.style.cssText = 'margin-bottom: 15px; padding: 12px; background: var(--background-primary-alt); border-radius: 5px; border-left: 3px solid var(--text-accent);';

            // Header with timestamp
            const headerEl = clipEl.createEl('div', { cls: 'clip-header' });
            headerEl.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';

            const timestampEl = headerEl.createEl('span', { cls: 'clip-timestamp' });
            timestampEl.style.cssText = 'font-weight: bold; font-size: 1.1em; color: var(--text-accent);';
            timestampEl.textContent = clip.timestamp || 'Unknown';

            const durationEl = headerEl.createEl('span', { cls: 'clip-duration' });
            durationEl.style.cssText = 'font-size: 0.9em; color: var(--text-muted);';
            durationEl.textContent = `${clip.duration || 30}s`;

            // Summary/description
            const summaryEl = clipEl.createEl('div', { cls: 'clip-summary' });
            summaryEl.style.cssText = 'margin-bottom: 10px; font-size: 0.95em;';
            summaryEl.textContent = clip.summary || clip.description || 'No description';

            // Transcript excerpt if available
            if (clip.excerpt) {
                const excerptEl = clipEl.createEl('div', { cls: 'clip-excerpt' });
                excerptEl.style.cssText = 'font-size: 0.85em; color: var(--text-muted); font-style: italic; margin-bottom: 10px; padding: 8px; background: var(--background-secondary); border-radius: 3px;';
                excerptEl.textContent = `"${clip.excerpt.substring(0, 200)}${clip.excerpt.length > 200 ? '...' : ''}"`;
            }

            // Extract button
            const btnEl = clipEl.createEl('button', { text: 'Extract This Clip' });
            btnEl.style.cssText = 'padding: 6px 12px; background: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 4px; cursor: pointer;';

            btnEl.addEventListener('click', async () => {
                btnEl.textContent = 'Extracting...';
                btnEl.disabled = true;

                // Parse timestamp to seconds
                const parts = (clip.timestamp || '0:00').split(':').map((p: string) => parseInt(p, 10));
                let startSeconds = 0;
                if (parts.length === 3) {
                    startSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                } else if (parts.length === 2) {
                    startSeconds = parts[0] * 60 + parts[1];
                }

                const clipPath = await this.plugin.doExtractClip(
                    clipData.video_id,
                    startSeconds,
                    clip.duration || 30,
                    `${sourceFile.basename}_${clip.timestamp?.replace(/:/g, '-') || 'clip'}`
                );

                if (clipPath) {
                    new Notice(`Clip saved: ${clipPath}`);
                    btnEl.textContent = 'Extracted!';
                    btnEl.style.background = 'var(--text-success)';

                    // Update the method file with clip info
                    let content = await this.app.vault.read(sourceFile);
                    if (!content.includes('## Extracted Clips')) {
                        content += `\n\n## Extracted Clips\n`;
                    }
                    content += `- [${clip.timestamp}] ${clip.summary?.substring(0, 50) || 'Clip'} - \`${clipPath}\`\n`;
                    await this.app.vault.modify(sourceFile, content);
                } else {
                    new Notice('Failed to extract clip');
                    btnEl.textContent = 'Failed - Try Again';
                    btnEl.disabled = false;
                }
            });
        }

        // Close button
        const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
        footerEl.style.cssText = 'margin-top: 15px; text-align: right;';

        new Setting(footerEl)
            .addButton(btn => btn
                .setButtonText('Close')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Linked Sources Modal - Shows sources from the parent Oracle article
class LinkedSourcesModal extends Modal {
    plugin: BJJFlipmodePlugin;
    sourcesData: any;
    sourceFile: TFile;

    constructor(app: App, plugin: BJJFlipmodePlugin, sourcesData: any, sourceFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.sourcesData = sourcesData;
        this.sourceFile = sourceFile;
    }

    onOpen() {
        const { contentEl } = this;
        const { sourcesData } = this;

        // Header
        contentEl.createEl('h2', { text: `Sources for: ${sourcesData.concept}` });

        // Meta info
        const metaEl = contentEl.createEl('div', { cls: 'sources-meta' });
        metaEl.style.cssText = 'margin-bottom: 20px; padding: 10px; background: var(--background-secondary); border-radius: 5px;';

        if (sourcesData.section_matched) {
            metaEl.createEl('p', { text: `📍 From section: "${sourcesData.section_matched}"` });
        }
        metaEl.createEl('p', { text: `Found ${sourcesData.total_sources} source${sourcesData.total_sources !== 1 ? 's' : ''} from your Oracle research` });

        // Info callout
        const infoEl = contentEl.createEl('div', { cls: 'info-callout' });
        infoEl.style.cssText = 'margin-bottom: 15px; padding: 10px; background: rgba(var(--color-green-rgb), 0.1); border-left: 3px solid var(--text-success); border-radius: 3px;';
        infoEl.createEl('p', {
            text: '✓ These are the exact videos cited in your Training Review - not a new search.',
            cls: 'info-text'
        });

        // Instructions
        contentEl.createEl('p', {
            text: 'Click any timestamp to generate a 60-second WebM clip:',
            cls: 'sources-instructions'
        });

        // Sources list
        const listEl = contentEl.createEl('div', { cls: 'sources-list' });
        listEl.style.cssText = 'max-height: 400px; overflow-y: auto;';

        const sources = sourcesData.sources || [];

        if (sources.length === 0) {
            listEl.createEl('p', { text: 'No linked sources found for this concept.' });
        }

        for (const source of sources) {
            const sourceEl = listEl.createEl('div', { cls: 'source-item' });

            // Relevance-based border color
            const borderColor = source.relevance === 'high' ? 'var(--text-success)' :
                               source.relevance === 'medium' ? 'var(--text-warning)' :
                               'var(--text-muted)';
            sourceEl.style.cssText = `padding: 12px; margin: 8px 0; border-radius: 5px; background: var(--background-secondary); cursor: pointer; border-left: 3px solid ${borderColor};`;

            // Header row with timestamp and title
            const headerRow = sourceEl.createEl('div', { cls: 'source-header' });
            headerRow.style.cssText = 'display: flex; align-items: center; gap: 10px;';

            // Timestamp badge
            const timestampBadge = headerRow.createEl('span', { cls: 'timestamp-badge' });
            timestampBadge.style.cssText = 'display: inline-block; background: var(--interactive-accent); color: white; padding: 2px 8px; border-radius: 3px; font-family: monospace;';
            timestampBadge.textContent = source.timestamp || '0:00';

            // Title
            headerRow.createEl('strong', { text: source.video_title || 'Unknown Video' });

            // Instructor line
            const instructorEl = sourceEl.createEl('p', { cls: 'source-instructor' });
            instructorEl.style.cssText = 'margin: 5px 0; font-size: 0.9em; color: var(--text-accent);';
            instructorEl.textContent = `👤 ${source.instructor || 'Unknown'}`;

            // Context preview
            if (source.context) {
                const contextEl = sourceEl.createEl('p', { cls: 'source-context' });
                contextEl.style.cssText = 'margin-top: 5px; font-size: 0.85em; color: var(--text-muted); font-style: italic;';
                contextEl.textContent = `"${source.context.substring(0, 150)}${source.context.length > 150 ? '...' : ''}"`;
            }

            // Click handler - generate clip
            sourceEl.addEventListener('click', async () => {
                timestampBadge.textContent = 'Generating...';
                timestampBadge.style.background = 'var(--text-warning)';

                const clipsFolder = `${this.sourceFile.parent?.path || this.plugin.settings.syncFolder}/clips/${source.video_id}`;
                const clipPath = await this.plugin.generateClipOnDemand(
                    source.video_id,
                    source.timestamp_seconds || 0,
                    clipsFolder
                );

                if (clipPath) {
                    timestampBadge.textContent = 'Done!';
                    timestampBadge.style.background = 'var(--text-success)';
                    new Notice(`Clip saved: ${clipPath}`, 3000);

                    // Open the clip
                    const clipFile = this.app.vault.getAbstractFileByPath(clipPath);
                    if (clipFile instanceof TFile) {
                        await this.app.workspace.getLeaf('split').openFile(clipFile);
                    }
                } else {
                    timestampBadge.textContent = 'Failed';
                    timestampBadge.style.background = 'var(--text-error)';
                    new Notice('Failed to generate clip', 3000);
                }

                // Reset after delay
                setTimeout(() => {
                    timestampBadge.textContent = source.timestamp || '0:00';
                    timestampBadge.style.background = 'var(--interactive-accent)';
                }, 3000);
            });

            // Hover effects
            sourceEl.addEventListener('mouseenter', () => {
                sourceEl.style.background = 'var(--background-modifier-hover)';
            });
            sourceEl.addEventListener('mouseleave', () => {
                sourceEl.style.background = 'var(--background-secondary)';
            });
        }

        // Footer buttons
        const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
        footerEl.style.cssText = 'margin-top: 20px; display: flex; gap: 10px;';

        new Setting(footerEl)
            .addButton(btn => btn
                .setButtonText('Generate All Clips')
                .setCta()
                .onClick(async () => {
                    btn.setButtonText('Generating...');
                    btn.setDisabled(true);

                    let generated = 0;

                    for (const source of sources) {
                        const clipsFolder = `${this.sourceFile.parent?.path || this.plugin.settings.syncFolder}/clips/${source.video_id}`;
                        const clipPath = await this.plugin.generateClipOnDemand(
                            source.video_id,
                            source.timestamp_seconds || 0,
                            clipsFolder
                        );
                        if (clipPath) generated++;
                    }

                    new Notice(`Generated ${generated}/${sources.length} clips!`, 5000);
                    btn.setButtonText('Done!');

                    setTimeout(() => this.close(), 2000);
                }))
            .addButton(btn => btn
                .setButtonText('Try Semantic Search')
                .onClick(async () => {
                    // Fall back to semantic search
                    this.close();
                    new Notice('Trying semantic search...', 2000);

                    try {
                        const response = await requestUrl({
                            url: `${this.plugin.settings.serverUrl}/api/obsidian/explore-video`,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                            },
                            body: JSON.stringify({ concept: sourcesData.concept })
                        });

                        const data = response.json;

                        if (!data.error) {
                            const modal = new VideoExplorerModal(
                                this.app,
                                this.plugin,
                                data,
                                this.sourceFile
                            );
                            modal.open();
                        } else {
                            new Notice('No videos found via semantic search', 3000);
                        }
                    } catch (error: any) {
                        new Notice(`Search failed: ${error.message}`, 3000);
                    }
                }))
            .addButton(btn => btn
                .setButtonText('Close')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Video Explorer Modal - Browse video with clickable timestamps
class VideoExplorerModal extends Modal {
    plugin: BJJFlipmodePlugin;
    videoData: any;
    sourceFile: TFile;

    constructor(app: App, plugin: BJJFlipmodePlugin, videoData: any, sourceFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.videoData = videoData;
        this.sourceFile = sourceFile;
    }

    onOpen() {
        const { contentEl } = this;
        const { videoData } = this;

        // Header
        contentEl.createEl('h2', { text: `Video: ${videoData.title || 'Unknown'}` });

        const metaEl = contentEl.createEl('div', { cls: 'video-meta' });
        metaEl.style.cssText = 'margin-bottom: 20px; padding: 10px; background: var(--background-secondary); border-radius: 5px;';
        metaEl.createEl('p', { text: `Instructor: ${videoData.instructor || 'Unknown'}` });
        metaEl.createEl('p', { text: `Video ID: ${videoData.video_id}` });
        metaEl.createEl('p', { text: `Found ${videoData.total_techniques || 0} techniques with timestamps` });

        // Instructions
        contentEl.createEl('p', {
            text: 'Click any timestamp to generate a 60-second WebM clip:',
            cls: 'video-explorer-instructions'
        });

        // Techniques list
        const listEl = contentEl.createEl('div', { cls: 'techniques-list' });
        listEl.style.cssText = 'max-height: 400px; overflow-y: auto;';

        const techniques = videoData.techniques || [];

        if (techniques.length === 0) {
            listEl.createEl('p', { text: 'No timestamped techniques found in this video.' });
        }

        for (const tech of techniques) {
            const techEl = listEl.createEl('div', { cls: 'technique-item' });
            techEl.style.cssText = 'padding: 12px; margin: 8px 0; border-radius: 5px; background: var(--background-secondary); cursor: pointer; border-left: 3px solid var(--interactive-accent);';

            // Timestamp badge
            const timestampBadge = techEl.createEl('span', { cls: 'timestamp-badge' });
            timestampBadge.style.cssText = 'display: inline-block; background: var(--interactive-accent); color: white; padding: 2px 8px; border-radius: 3px; font-family: monospace; margin-right: 10px;';
            timestampBadge.textContent = tech.timestamp || '0:00';

            // Technique name
            techEl.createEl('strong', { text: tech.name || 'Untitled' });

            // Description
            if (tech.description) {
                const descEl = techEl.createEl('p', { cls: 'technique-description' });
                descEl.style.cssText = 'margin-top: 5px; font-size: 0.9em; color: var(--text-muted);';
                descEl.textContent = tech.description.substring(0, 200) + (tech.description.length > 200 ? '...' : '');
            }

            // Click handler - generate clip
            techEl.addEventListener('click', async () => {
                timestampBadge.textContent = 'Generating...';
                timestampBadge.style.background = 'var(--text-warning)';

                const clipsFolder = `${this.sourceFile.parent?.path || this.plugin.settings.syncFolder}/clips/${this.videoData.video_id}`;
                const clipPath = await this.plugin.generateClipOnDemand(
                    videoData.video_id,
                    tech.timestamp_seconds || 0,
                    clipsFolder
                );

                if (clipPath) {
                    timestampBadge.textContent = 'Done!';
                    timestampBadge.style.background = 'var(--text-success)';
                    new Notice(`Clip saved: ${clipPath}`, 3000);

                    // Open the clip
                    const clipFile = this.app.vault.getAbstractFileByPath(clipPath);
                    if (clipFile instanceof TFile) {
                        await this.app.workspace.getLeaf('split').openFile(clipFile);
                    }
                } else {
                    timestampBadge.textContent = 'Failed';
                    timestampBadge.style.background = 'var(--text-error)';
                    new Notice('Failed to generate clip', 3000);
                }

                // Reset after delay
                setTimeout(() => {
                    timestampBadge.textContent = tech.timestamp || '0:00';
                    timestampBadge.style.background = 'var(--interactive-accent)';
                }, 3000);
            });

            // Hover effects
            techEl.addEventListener('mouseenter', () => {
                techEl.style.background = 'var(--background-modifier-hover)';
            });
            techEl.addEventListener('mouseleave', () => {
                techEl.style.background = 'var(--background-secondary)';
            });
        }

        // Footer buttons
        const footerEl = contentEl.createEl('div', { cls: 'modal-footer' });
        footerEl.style.cssText = 'margin-top: 20px; display: flex; gap: 10px;';

        new Setting(footerEl)
            .addButton(btn => btn
                .setButtonText('Expand to Full Series')
                .onClick(async () => {
                    btn.setButtonText('Loading...');
                    btn.setDisabled(true);

                    try {
                        // Get series data
                        const response = await requestUrl({
                            url: `${this.plugin.settings.serverUrl}/api/obsidian/explore-series`,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${this.plugin.settings.apiToken}`
                            },
                            body: JSON.stringify({
                                concept: this.videoData.concept_searched || this.videoData.title,
                                instructor: this.videoData.instructor
                            })
                        });

                        const seriesData = response.json;

                        if (seriesData.error) {
                            new Notice('No series found', 3000);
                            btn.setButtonText('Expand to Full Series');
                            btn.setDisabled(false);
                            return;
                        }

                        // Close this modal and open Series Explorer
                        this.close();
                        const seriesModal = new SeriesExplorerModal(
                            this.app,
                            this.plugin,
                            seriesData,
                            this.sourceFile
                        );
                        seriesModal.open();

                    } catch (error: any) {
                        new Notice(`Failed to load series: ${error.message}`, 3000);
                        btn.setButtonText('Expand to Full Series');
                        btn.setDisabled(false);
                    }
                }))
            .addButton(btn => btn
                .setButtonText('Generate All Clips')
                .setCta()
                .onClick(async () => {
                    btn.setButtonText('Generating...');
                    btn.setDisabled(true);

                    const clipsFolder = `${this.sourceFile.parent?.path || this.plugin.settings.syncFolder}/clips/${this.videoData.video_id}`;
                    let generated = 0;

                    for (const tech of techniques) {
                        const clipPath = await this.plugin.generateClipOnDemand(
                            videoData.video_id,
                            tech.timestamp_seconds || 0,
                            clipsFolder
                        );
                        if (clipPath) generated++;
                    }

                    new Notice(`Generated ${generated}/${techniques.length} clips!`, 5000);
                    btn.setButtonText('Done!');

                    setTimeout(() => this.close(), 2000);
                }))
            .addButton(btn => btn
                .setButtonText('Close')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Series Explorer Modal - Browse entire video series with all volumes
class SeriesExplorerModal extends Modal {
    plugin: BJJFlipmodePlugin;
    seriesData: any;
    sourceFile: TFile;

    constructor(app: App, plugin: BJJFlipmodePlugin, seriesData: any, sourceFile: TFile) {
        super(app);
        this.plugin = plugin;
        this.seriesData = seriesData;
        this.sourceFile = sourceFile;
    }

    onOpen() {
        const { contentEl } = this;
        const { seriesData } = this;

        // Header
        contentEl.createEl('h2', { text: `Series: ${seriesData.series_name || 'Unknown'}` });

        const metaEl = contentEl.createEl('div', { cls: 'series-meta' });
        metaEl.style.cssText = 'margin-bottom: 20px; padding: 10px; background: var(--background-secondary); border-radius: 5px;';
        metaEl.createEl('p', { text: `Instructor: ${seriesData.instructor || 'Unknown'}` });
        metaEl.createEl('p', { text: `Total Volumes: ${seriesData.total_volumes || 0}` });

        // Volumes accordion
        const volumesEl = contentEl.createEl('div', { cls: 'volumes-list' });
        volumesEl.style.cssText = 'max-height: 500px; overflow-y: auto;';

        const volumes = seriesData.volumes || [];

        for (const vol of volumes) {
            // Volume header (collapsible)
            const volContainer = volumesEl.createEl('div', { cls: 'volume-container' });
            volContainer.style.cssText = 'margin-bottom: 10px; border: 1px solid var(--background-modifier-border); border-radius: 5px;';

            const volHeader = volContainer.createEl('div', { cls: 'volume-header' });
            volHeader.style.cssText = 'padding: 12px; background: var(--interactive-accent); color: white; cursor: pointer; border-radius: 5px 5px 0 0; display: flex; justify-content: space-between; align-items: center;';

            volHeader.createEl('strong', { text: `Volume ${vol.volume}: ${vol.title || ''}` });

            const techCount = volHeader.createEl('span');
            techCount.textContent = `${vol.total_techniques || 0} techniques`;
            techCount.style.cssText = 'font-size: 0.85em; opacity: 0.9;';

            // Techniques list (hidden by default)
            const techList = volContainer.createEl('div', { cls: 'technique-list' });
            techList.style.cssText = 'display: none; padding: 10px; background: var(--background-primary);';

            // Toggle visibility
            volHeader.addEventListener('click', () => {
                const isVisible = techList.style.display !== 'none';
                techList.style.display = isVisible ? 'none' : 'block';
                volHeader.style.borderRadius = isVisible ? '5px 5px 0 0' : '5px';
            });

            // Add techniques
            for (const tech of (vol.techniques || [])) {
                const techEl = techList.createEl('div', { cls: 'technique-item' });
                techEl.style.cssText = 'padding: 8px; margin: 4px 0; border-radius: 3px; background: var(--background-secondary); cursor: pointer; border-left: 3px solid var(--text-accent);';

                const timestampBadge = techEl.createEl('span');
                timestampBadge.style.cssText = 'display: inline-block; background: var(--text-accent); color: white; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.85em; margin-right: 8px;';
                timestampBadge.textContent = tech.timestamp || '0:00';

                techEl.createEl('span', { text: tech.name || 'Untitled' });

                // Click to generate clip
                techEl.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    timestampBadge.textContent = '...';
                    timestampBadge.style.background = 'var(--text-warning)';

                    const clipsFolder = `${this.sourceFile.parent?.path || this.plugin.settings.syncFolder}/clips/${vol.video_id}`;
                    const clipPath = await this.plugin.generateClipOnDemand(
                        vol.video_id,
                        tech.timestamp_seconds || 0,
                        clipsFolder
                    );

                    if (clipPath) {
                        timestampBadge.textContent = 'OK';
                        timestampBadge.style.background = 'var(--text-success)';
                        new Notice(`Clip saved!`, 2000);
                    } else {
                        timestampBadge.textContent = 'X';
                        timestampBadge.style.background = 'var(--text-error)';
                    }

                    setTimeout(() => {
                        timestampBadge.textContent = tech.timestamp || '0:00';
                        timestampBadge.style.background = 'var(--text-accent)';
                    }, 2000);
                });

                techEl.addEventListener('mouseenter', () => techEl.style.background = 'var(--background-modifier-hover)');
                techEl.addEventListener('mouseleave', () => techEl.style.background = 'var(--background-secondary)');
            }
        }

        // Footer
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Close')
                .onClick(() => this.close()));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Coach Push Concepts Modal - Select athlete to push concepts to
class CoachPushConceptsModal extends Modal {
    plugin: BJJFlipmodePlugin;
    concepts: any[];

    constructor(app: App, plugin: BJJFlipmodePlugin, concepts: any[]) {
        super(app);
        this.plugin = plugin;
        this.concepts = concepts;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Push Concepts to Athlete' });
        contentEl.createEl('p', { text: `${this.concepts.length} concepts ready to push` });

        // Load athletes
        let athletes: any[] = [];
        try {
            athletes = await this.plugin.coachClient!.getAthletes();
        } catch {
            contentEl.createEl('p', { text: 'Failed to load athletes' });
            return;
        }

        if (athletes.length === 0) {
            contentEl.createEl('p', { text: 'No athletes in roster. Add athletes first.' });
            return;
        }

        let selectedAthleteId: number | null = null;

        new Setting(contentEl)
            .setName('Select Athlete')
            .addDropdown(dropdown => {
                dropdown.addOption('', 'Choose athlete...');
                for (const athlete of athletes) {
                    dropdown.addOption(
                        String(athlete.id),
                        athlete.display_name || athlete.discord_username || `Athlete ${athlete.id}`
                    );
                }
                dropdown.onChange(value => {
                    selectedAthleteId = value ? parseInt(value) : null;
                });
            });

        // Concept list preview
        const listEl = contentEl.createEl('div', { cls: 'concept-list' });
        listEl.createEl('h4', { text: 'Concepts:' });
        const ul = listEl.createEl('ul');
        for (const c of this.concepts.slice(0, 10)) {
            ul.createEl('li', { text: `${c.name} (${c.category})` });
        }
        if (this.concepts.length > 10) {
            ul.createEl('li', { text: `... and ${this.concepts.length - 10} more` });
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Push Concepts')
                .setCta()
                .onClick(async () => {
                    if (!selectedAthleteId) {
                        new Notice('Select an athlete first');
                        return;
                    }
                    try {
                        new Notice('Pushing concepts...');
                        const result = await this.plugin.coachClient!.pushConcepts(selectedAthleteId, this.concepts);
                        new Notice(`Pushed! ${result.created} new, ${result.updated} updated`);
                        this.close();
                    } catch (error) {
                        console.error('Push concepts error:', error);
                        new Notice('Failed to push concepts');
                    }
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Pending Jobs Modal - View remote queue status
class PendingJobsModal extends Modal {
    plugin: BJJFlipmodePlugin;

    constructor(app: App, plugin: BJJFlipmodePlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flipmode-pending-modal');

        contentEl.createEl('h2', { text: 'Pending Coach Queries' });

        if (!this.plugin.isRemoteMode()) {
            contentEl.createEl('p', { text: 'Remote mode not configured. Enable in settings.' });
            return;
        }

        // Refresh button
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Refresh')
                .onClick(() => this.refresh()));

        // Jobs list
        const jobsContainer = contentEl.createDiv({ cls: 'pending-jobs-list' });
        jobsContainer.style.marginTop = '15px';

        await this.loadJobs(jobsContainer);
    }

    async loadJobs(container: HTMLElement) {
        container.empty();

        try {
            const jobs = await this.plugin.queueClient!.listJobs();

            if (jobs.length === 0) {
                container.createEl('p', {
                    text: 'No pending queries',
                    cls: 'no-jobs'
                });
                return;
            }

            for (const job of jobs) {
                const jobDiv = container.createDiv({ cls: 'job-item' });
                jobDiv.style.background = 'var(--background-secondary)';
                jobDiv.style.padding = '12px';
                jobDiv.style.borderRadius = '8px';
                jobDiv.style.marginBottom = '10px';

                // Status indicator
                const statusColors: Record<string, string> = {
                    'pending': 'var(--text-muted)',
                    'processing': 'var(--text-accent)',
                    'complete': 'var(--text-success)',
                    'error': 'var(--text-error)'
                };

                const statusEl = jobDiv.createEl('span', {
                    text: job.status.toUpperCase(),
                    cls: 'job-status'
                });
                statusEl.style.color = statusColors[job.status] || 'var(--text-muted)';
                statusEl.style.fontWeight = '600';
                statusEl.style.marginRight = '10px';

                // Query text
                const queryEl = jobDiv.createEl('span', {
                    text: job.query_text.substring(0, 50) + (job.query_text.length > 50 ? '...' : '')
                });

                // Submitted time
                const timeEl = jobDiv.createEl('div', {
                    text: `Submitted: ${new Date(job.submitted_at).toLocaleString()}`,
                    cls: 'job-time'
                });
                timeEl.style.fontSize = '0.85em';
                timeEl.style.color = 'var(--text-muted)';
                timeEl.style.marginTop = '5px';
            }
        } catch (error) {
            container.createEl('p', {
                text: 'Failed to load jobs. Check connection.',
                cls: 'error'
            });
        }
    }

    async refresh() {
        const container = this.contentEl.querySelector('.pending-jobs-list') as HTMLElement;
        if (container) {
            await this.loadJobs(container);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Settings Tab
class BJJFlipmodeSettingTab extends PluginSettingTab {
    plugin: BJJFlipmodePlugin;

    constructor(app: App, plugin: BJJFlipmodePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Flipmode Settings' });

        // Mode selection
        new Setting(containerEl)
            .setName('Mode')
            .setDesc('Local: Direct Oracle. Remote: Athlete sending to Oracle. Coach: Process athlete queries.')
            .addDropdown(dropdown => dropdown
                .addOption('local', 'Local (Direct Oracle)')
                .addOption('remote', 'Remote (Athlete)')
                .addOption('coach', 'Coach (Process Queries)')
                .setValue(this.plugin.settings.mode)
                .onChange(async (value: 'local' | 'remote' | 'coach') => {
                    this.plugin.settings.mode = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide relevant settings
                }));

        // ATHLETE IDENTITY
        containerEl.createEl('h3', { text: 'Athlete Identity' });

        new Setting(containerEl)
            .setName('Athlete Name')
            .setDesc('Your name (used for folder organization: Flipmode/Athletes/{Name}/Sessions/)')
            .addText(text => text
                .setPlaceholder('Enter athlete name')
                .setValue(this.plugin.settings.athleteName)
                .onChange(async (value) => {
                    this.plugin.settings.athleteName = value || 'Athlete';
                    await this.plugin.saveSettings();
                }));

        // SEASON/EPISODE TRACKING (all modes)
        containerEl.createEl('h3', { text: 'Season & Episode Tracking' });
        containerEl.createEl('p', {
            text: `Current: ${this.plugin.settings.athleteName} - S${this.plugin.settings.currentSeason}E${String(this.plugin.settings.currentEpisode).padStart(2, '0')}`,
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName('Current Season')
            .setDesc('Training season number (e.g., competition prep, off-season)')
            .addText(text => text
                .setValue(String(this.plugin.settings.currentSeason))
                .onChange(async (value) => {
                    const num = parseInt(value) || 1;
                    this.plugin.settings.currentSeason = Math.max(1, num);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Current Episode')
            .setDesc('Session number within the season')
            .addText(text => text
                .setValue(String(this.plugin.settings.currentEpisode))
                .onChange(async (value) => {
                    const num = parseInt(value) || 1;
                    this.plugin.settings.currentEpisode = Math.max(1, num);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Start New Season')
            .setDesc('Increment season number and reset episode to 1')
            .addButton(btn => btn
                .setButtonText('New Season')
                .onClick(async () => {
                    this.plugin.settings.currentSeason += 1;
                    this.plugin.settings.currentEpisode = 1;
                    await this.plugin.saveSettings();
                    this.display();
                    new Notice(`Started Season ${this.plugin.settings.currentSeason}!`);
                }));

        if (this.plugin.settings.mode === 'local') {
            // LOCAL MODE SETTINGS
            containerEl.createEl('h3', { text: 'Local Mode Settings' });

            // Server URL
            new Setting(containerEl)
                .setName('Server URL')
                .setDesc('URL of your Flipmode server')
                .addText(text => text
                    .setPlaceholder('http://localhost:5005')
                    .setValue(this.plugin.settings.serverUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.serverUrl = value;
                        await this.plugin.saveSettings();
                    }));

            // API Token
            new Setting(containerEl)
                .setName('API Token')
                .setDesc('Your API token from the Flipmode profile page')
                .addText(text => text
                    .setPlaceholder('Enter your API token')
                    .setValue(this.plugin.settings.apiToken)
                    .onChange(async (value) => {
                        this.plugin.settings.apiToken = value;
                        await this.plugin.saveSettings();
                    }));

            // Test Connection button
            new Setting(containerEl)
                .setName('Test Connection')
                .setDesc('Verify connection to Flipmode server')
                .addButton(btn => btn
                    .setButtonText('Test')
                    .onClick(async () => {
                        const connected = await this.plugin.checkConnection();
                        new Notice(connected
                            ? 'Successfully connected to Flipmode!'
                            : 'Could not connect to Flipmode');
                    }));

        } else if (this.plugin.settings.mode === 'remote') {
            // REMOTE MODE SETTINGS
            containerEl.createEl('h3', { text: 'Remote Mode Settings (Athlete)' });

            // Queue Service URL
            new Setting(containerEl)
                .setName('Queue Service URL')
                .setDesc('URL of the Oracle queue service (e.g., https://your-app.herokuapp.com)')
                .addText(text => text
                    .setPlaceholder('https://flipmode-queue.herokuapp.com')
                    .setValue(this.plugin.settings.queueServiceUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.queueServiceUrl = value;
                        await this.plugin.saveSettings();
                    }));

            // Connect with Discord
            new Setting(containerEl)
                .setName('Connect with Discord')
                .setDesc('Authenticate via Discord to connect with Oracle')
                .addButton(btn => btn
                    .setButtonText('Connect Discord')
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.connectWithDiscord();
                    }));

            // Athlete Token (from Discord OAuth)
            new Setting(containerEl)
                .setName('Athlete Token')
                .setDesc('Your athlete token (obtained after Discord connection)')
                .addText(text => text
                    .setPlaceholder('Paste token from Discord auth')
                    .setValue(this.plugin.settings.athleteToken)
                    .onChange(async (value) => {
                        this.plugin.settings.athleteToken = value;
                        await this.plugin.saveSettings();
                        // Re-initialize remote mode
                        if (value && this.plugin.settings.queueServiceUrl) {
                            this.plugin.initRemoteMode();
                        }
                    }));

            // Poll Interval
            new Setting(containerEl)
                .setName('Poll Interval')
                .setDesc('Seconds between checking for results')
                .addSlider(slider => slider
                    .setLimits(5, 60, 5)
                    .setValue(this.plugin.settings.pollInterval)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.pollInterval = value;
                        await this.plugin.saveSettings();
                        if (this.plugin.isRemoteMode()) {
                            this.plugin.startResultPolling();
                        }
                    }));

            // Test Queue Connection
            new Setting(containerEl)
                .setName('Test Queue Connection')
                .setDesc('Verify connection to Oracle queue')
                .addButton(btn => btn
                    .setButtonText('Test')
                    .onClick(async () => {
                        if (!this.plugin.settings.queueServiceUrl) {
                            new Notice('Configure Queue Service URL first');
                            return;
                        }
                        try {
                            const client = new RemoteQueueClient(
                                this.plugin.settings.queueServiceUrl,
                                this.plugin.settings.athleteToken
                            );
                            const healthy = await client.checkHealth();
                            new Notice(healthy
                                ? 'Queue service is healthy!'
                                : 'Queue service not responding');
                        } catch (error) {
                            new Notice('Failed to connect to queue service');
                        }
                    }));

            // View Pending Jobs
            new Setting(containerEl)
                .setName('Pending Queries')
                .setDesc('View your pending Oracle queries')
                .addButton(btn => btn
                    .setButtonText('View Jobs')
                    .onClick(() => {
                        this.plugin.showPendingJobsModal();
                    }));

            // Sync Graph to Coach
            new Setting(containerEl)
                .setName('Sync Graph')
                .setDesc('Send your research graph to Oracle')
                .addButton(btn => btn
                    .setButtonText('Sync Now')
                    .onClick(async () => {
                        await this.plugin.syncGraphToCoach();
                    }));

        } else if (this.plugin.settings.mode === 'coach') {
            // COACH MODE SETTINGS
            containerEl.createEl('h3', { text: 'Coach Mode Settings' });

            // Queue Service URL
            new Setting(containerEl)
                .setName('Queue Service URL')
                .setDesc('URL of the queue service (same as athletes use)')
                .addText(text => text
                    .setPlaceholder('https://flipmode-queue.herokuapp.com')
                    .setValue(this.plugin.settings.queueServiceUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.queueServiceUrl = value;
                        await this.plugin.saveSettings();
                    }));

            // Coach Token
            new Setting(containerEl)
                .setName('Coach Token')
                .setDesc('Your coach API token (from registration)')
                .addText(text => text
                    .setPlaceholder('Your coach token')
                    .setValue(this.plugin.settings.coachToken)
                    .onChange(async (value) => {
                        this.plugin.settings.coachToken = value;
                        await this.plugin.saveSettings();
                        if (value && this.plugin.settings.queueServiceUrl) {
                            this.plugin.initCoachMode();
                        }
                    }));

            // Local Oracle URL (for generating articles)
            new Setting(containerEl)
                .setName('Local Oracle URL')
                .setDesc('Your local Flipmode server for generating articles')
                .addText(text => text
                    .setPlaceholder('http://localhost:5005')
                    .setValue(this.plugin.settings.serverUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.serverUrl = value;
                        await this.plugin.saveSettings();
                    }));

            // Test Connection
            new Setting(containerEl)
                .setName('Test Connection')
                .setDesc('Verify connection to queue service')
                .addButton(btn => btn
                    .setButtonText('Test')
                    .onClick(async () => {
                        if (!this.plugin.settings.queueServiceUrl) {
                            new Notice('Configure Queue Service URL first');
                            return;
                        }
                        try {
                            const client = new CoachQueueClient(
                                this.plugin.settings.queueServiceUrl,
                                this.plugin.settings.coachToken
                            );
                            const healthy = await client.checkHealth();
                            new Notice(healthy ? 'Connected!' : 'Service not responding');
                        } catch {
                            new Notice('Connection failed');
                        }
                    }));

            // Quick Actions
            containerEl.createEl('h4', { text: 'Quick Actions' });

            new Setting(containerEl)
                .setName('Sync Athletes')
                .setDesc('Pull all athlete data and pending queries')
                .addButton(btn => btn
                    .setButtonText('Sync Now')
                    .setCta()
                    .onClick(() => this.plugin.coachSyncAthletes()));

            new Setting(containerEl)
                .setName('View Pending')
                .setDesc('Open inbox with pending queries')
                .addButton(btn => btn
                    .setButtonText('View')
                    .onClick(() => this.plugin.coachShowPending()));

            new Setting(containerEl)
                .setName('Add Athlete')
                .setDesc('Add a new athlete to your roster')
                .addButton(btn => btn
                    .setButtonText('Add')
                    .onClick(() => this.plugin.coachAddAthlete()));
        }

        // COMMON SETTINGS
        containerEl.createEl('h3', { text: 'General Settings' });

        // Sync Folder
        new Setting(containerEl)
            .setName('Sync Folder')
            .setDesc('Folder in your vault for Flipmode content')
            .addText(text => text
                .setPlaceholder('Flipmode')
                .setValue(this.plugin.settings.syncFolder)
                .onChange(async (value) => {
                    this.plugin.settings.syncFolder = value;
                    await this.plugin.saveSettings();
                }));

        // Concepts Subfolder
        new Setting(containerEl)
            .setName('Concepts Subfolder')
            .setDesc('Subfolder for concept graphs (e.g., "concepts" → {syncFolder}/concepts/{topic}/)')
            .addText(text => text
                .setPlaceholder('concepts')
                .setValue(this.plugin.settings.conceptsSubfolder)
                .onChange(async (value) => {
                    this.plugin.settings.conceptsSubfolder = value || 'concepts';
                    await this.plugin.saveSettings();
                }));

        // Auto Sync
        new Setting(containerEl)
            .setName('Auto Sync')
            .setDesc('Automatically sync with Flipmode periodically')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.startAutoSync();
                    }
                }));

        // Sync Interval
        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('Minutes between automatic syncs')
            .addSlider(slider => slider
                .setLimits(5, 120, 5)
                .setValue(this.plugin.settings.syncInterval)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = value;
                    await this.plugin.saveSettings();
                }));
    }
}
