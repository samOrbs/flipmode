import { App, Editor, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, requestUrl } from 'obsidian';
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
    athleteName: 'Athlete'
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
            name: 'Sync from Coach (fetch completed research)',
            callback: async () => {
                await this.syncFromCoach();
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

        // Read all concept files from Concepts folder
        const conceptsFolder = `${this.settings.syncFolder}/Concepts`;
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

            new Notice('Query sent to coach! You\'ll be notified when ready.');
            return jobId;
        } catch (error) {
            console.error('Failed to submit query:', error);
            new Notice('Failed to send query to coach. Check your connection.');
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

*Waiting for coach to process...*

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
                new Notice(`Synced ${msg.join(' and ')} from coach!`);
            } else {
                new Notice('All research already synced');
            }
        } catch (error) {
            console.error('[Flipmode] Sync error:', error);
            new Notice('Failed to sync from coach');
        }
    }

    async syncConceptsToVault(concepts: any[]): Promise<number> {
        const folder = `${this.settings.syncFolder}/Concepts`;
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
tags: [concept, bjj, ${concept.category?.toLowerCase() || 'technique'}]
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
type: coach-research
job_id: ${job.job_id}
query: "${job.enriched_query || job.query_text}"
received: ${new Date().toISOString()}
rlm_session_id: ${result.rlm_session_id || ''}
tags: [bjj, research, from-coach]
---

# Research: ${shortQuery}

${result.article}

---
*Research provided by your coach*
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

            const concepts = result.concepts || [];
            if (concepts.length === 0) {
                new Notice('No concepts extracted');
                return;
            }

            // Create Concepts folder
            const conceptsFolder = `${this.settings.syncFolder}/Concepts`;
            await this.ensureFolder(conceptsFolder);

            // Create a note for each concept
            let createdCount = 0;
            for (const concept of concepts) {
                const conceptName = concept.name.replace(/[^\w\s-]/g, '').trim();
                const conceptPath = `${conceptsFolder}/${conceptName}.md`;

                // Check if concept already exists
                const existing = this.app.vault.getAbstractFileByPath(conceptPath);
                if (existing) {
                    // TODO: Could merge/update existing concept
                    continue;
                }

                // Build linked markdown
                const parentLink = concept.parent ? `[[${concept.parent}]]` : 'Root concept';
                const prereqLinks = (concept.prerequisites || []).map((p: string) => `- [[${p}]]`).join('\n') || '- None';
                const leadsToLinks = (concept.leads_to || []).map((l: string) => `- [[${l}]]`).join('\n') || '- None';
                const counterLinks = (concept.counters || []).map((c: string) => `- [[${c}]]`).join('\n') || '- None';
                const relatedLinks = (concept.related || []).map((r: string) => `- [[${r}]]`).join('\n') || '- None';

                const conceptContent = `---
type: concept
parent: "${concept.parent || ''}"
tags: [concept, bjj, ${concept.category?.toLowerCase() || 'technique'}]
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

                await this.app.vault.create(conceptPath, conceptContent);
                createdCount++;
            }

            new Notice(`Created ${createdCount} concept nodes! Open Graph View to explore.`, 5000);

        } catch (error) {
            console.error('Explode to Concept Graph error:', error);
            new Notice('Failed to explode concepts. Check console.', 5000);
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
                this.statusEl.setText('Transcribing via cloud (30s max, 5/day)...');

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
                        this.statusEl.setText('Recording too long (max 30 seconds)');
                        new Notice('Voice notes are limited to 30 seconds. Please record a shorter message.');
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

            this.statusEl.setText('Coach is speaking...');
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
            this.statusEl.setText(isRemote ? 'Ready to send to coach!' : 'Ready to generate wisdom!');
            this.statusEl.style.color = 'var(--text-success)';

            const bigBtnContainer = this.resultEl.createDiv();
            bigBtnContainer.style.textAlign = 'center';
            bigBtnContainer.style.marginTop = '30px';

            const generateBtn = bigBtnContainer.createEl('button', {
                text: isRemote ? '📤 Send to Coach' : '✨ Generate Wisdom',
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
                        new Notice('Query sent to coach! Check back later for results.', 5000);
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
                        researchLink = `> 📚 **Based on research:** [[${researchFileName}]]\n\n`;
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
            .setDesc('Local: Direct Oracle. Remote: Athlete sending to coach. Coach: Process athlete queries.')
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
                .setDesc('URL of the coach queue service (e.g., https://your-app.herokuapp.com)')
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
                .setDesc('Authenticate with your coach via Discord')
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
                .setDesc('Verify connection to coach queue')
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
                .setDesc('View your pending coach queries')
                .addButton(btn => btn
                    .setButtonText('View Jobs')
                    .onClick(() => {
                        this.plugin.showPendingJobsModal();
                    }));

            // Sync Graph to Coach
            new Setting(containerEl)
                .setName('Sync Graph')
                .setDesc('Send your research graph to your coach')
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
