import { __awaiter } from "tslib";
import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
const DEFAULT_SETTINGS = {
    serverUrl: 'http://localhost:5005',
    apiToken: '',
    syncFolder: 'Flipmode',
    autoSync: false,
    syncInterval: 30,
    userId: 'default'
};
export default class BJJFlipmodePlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.syncIntervalId = null;
    }
    onload() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.loadSettings();
            // Add status bar item
            this.statusBarItem = this.addStatusBarItem();
            this.updateStatusBar('Disconnected');
            // Add ribbon icon
            this.addRibbonIcon('brain-circuit', 'Flipmode', () => __awaiter(this, void 0, void 0, function* () {
                yield this.showFlipmodeMenu();
            }));
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
                editorCallback: (editor, view) => {
                    this.insertTrainingTemplate(editor);
                }
            });
            this.addCommand({
                id: 'flipmode-check-connection',
                name: 'Check Flipmode connection',
                callback: () => this.checkConnection()
            });
            // Add settings tab
            this.addSettingTab(new BJJFlipmodeSettingTab(this.app, this));
            // Check connection on startup
            this.checkConnection();
            // Start auto-sync if enabled
            if (this.settings.autoSync) {
                this.startAutoSync();
            }
        });
    }
    onunload() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }
    }
    loadSettings() {
        return __awaiter(this, void 0, void 0, function* () {
            this.settings = Object.assign({}, DEFAULT_SETTINGS, yield this.loadData());
        });
    }
    saveSettings() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.saveData(this.settings);
        });
    }
    updateStatusBar(status) {
        this.statusBarItem.setText(`Flipmode: ${status}`);
    }
    // API Methods
    apiRequest(endpoint, method = 'GET', body) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = `${this.settings.serverUrl}/api/obsidian${endpoint}`;
            try {
                const response = yield requestUrl({
                    url,
                    method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.settings.apiToken}`
                    },
                    body: body ? JSON.stringify(body) : undefined
                });
                return response.json;
            }
            catch (error) {
                console.error('Flipmode API error:', error);
                throw error;
            }
        });
    }
    checkConnection() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield this.apiRequest('/health');
                if (response.status === 'healthy') {
                    this.updateStatusBar('Connected');
                    return true;
                }
            }
            catch (error) {
                this.updateStatusBar('Disconnected');
            }
            return false;
        });
    }
    // Sync Methods
    syncWithFlipmode() {
        return __awaiter(this, void 0, void 0, function* () {
            const connected = yield this.checkConnection();
            if (!connected) {
                new Notice('Cannot connect to Flipmode server');
                return;
            }
            new Notice('Syncing with Flipmode...');
            try {
                // Get sync manifest
                const userId = this.settings.apiToken.substring(0, 8) || 'default';
                const manifest = yield this.apiRequest(`/sync/manifest/${userId}`);
                // Ensure directories exist
                yield this.ensureFoldersExist(manifest.directories);
                // Sync each file
                let syncedCount = 0;
                for (const file of manifest.files) {
                    const synced = yield this.syncFile(file);
                    if (synced)
                        syncedCount++;
                }
                new Notice(`Synced ${syncedCount} files from Flipmode`);
            }
            catch (error) {
                console.error('Sync error:', error);
                new Notice('Sync failed - check console for details');
            }
        });
    }
    ensureFoldersExist(paths) {
        return __awaiter(this, void 0, void 0, function* () {
            for (const path of paths) {
                const folder = this.app.vault.getAbstractFileByPath(path);
                if (!folder) {
                    yield this.app.vault.createFolder(path);
                }
            }
        });
    }
    syncFile(file) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const existingFile = this.app.vault.getAbstractFileByPath(file.path);
                if (existingFile instanceof TFile) {
                    // Check if content changed
                    const currentContent = yield this.app.vault.read(existingFile);
                    if (this.computeChecksum(currentContent) !== file.checksum) {
                        yield this.app.vault.modify(existingFile, file.content);
                        return true;
                    }
                    return false;
                }
                else {
                    // Create new file
                    yield this.app.vault.create(file.path, file.content);
                    return true;
                }
            }
            catch (error) {
                console.error(`Error syncing file ${file.path}:`, error);
                return false;
            }
        });
    }
    computeChecksum(content) {
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
        this.syncIntervalId = window.setInterval(() => this.syncWithFlipmode(), this.settings.syncInterval * 60 * 1000);
    }
    // UI Methods
    showFlipmodeMenu() {
        return __awaiter(this, void 0, void 0, function* () {
            new FlipmodeMenuModal(this.app, this).open();
        });
    }
    showResearchModal() {
        return __awaiter(this, void 0, void 0, function* () {
            new ResearchModal(this.app, this).open();
        });
    }
    showVoiceNoteModal() {
        return __awaiter(this, void 0, void 0, function* () {
            new VoiceNoteModal(this.app, this).open();
        });
    }
    // Voice session method
    startVoiceSession(audioBase64) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield this.apiRequest('/session', 'POST', {
                    user_id: this.settings.userId,
                    audio_base64: audioBase64,
                    audio_format: 'webm'
                });
                return response;
            }
            catch (error) {
                console.error('Voice session error:', error);
                throw error;
            }
        });
    }
    // Continue conversation
    respondToSession(sessionId, text, audioBase64, selectedOption) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const body = {
                    session_id: sessionId,
                    user_id: this.settings.userId
                };
                if (audioBase64) {
                    body.audio_base64 = audioBase64;
                    body.audio_format = 'webm';
                }
                else if (text) {
                    body.text = text;
                }
                else if (selectedOption) {
                    body.selected_option = selectedOption;
                }
                const response = yield this.apiRequest('/respond', 'POST', body);
                return response;
            }
            catch (error) {
                console.error('Respond error:', error);
                throw error;
            }
        });
    }
    saveSessionToVault(session) {
        var _a, _b, _c;
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const date = new Date().toISOString().split('T')[0];
                const folder = this.settings.syncFolder + '/Sessions';
                yield this.ensureFoldersExist([folder]);
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
                    if ((_a = topics.work_on) === null || _a === void 0 ? void 0 : _a.length) {
                        content += `### Work On\n`;
                        for (const t of topics.work_on) {
                            content += `- **${t.topic}**: ${t.context || ''}\n`;
                        }
                        content += '\n';
                    }
                    if ((_b = topics.wins) === null || _b === void 0 ? void 0 : _b.length) {
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
                if ((_c = session.options) === null || _c === void 0 ? void 0 : _c.length) {
                    content += `## Next Steps\n\n`;
                    for (const opt of session.options) {
                        content += `- [ ] ${opt.label}\n`;
                    }
                }
                const filename = `${folder}/${date}-${session.session_id.substring(0, 8)}.md`;
                const existingFile = this.app.vault.getAbstractFileByPath(filename);
                if (existingFile instanceof TFile) {
                    yield this.app.vault.modify(existingFile, content);
                }
                else {
                    yield this.app.vault.create(filename, content);
                }
                // Open the file
                const file = this.app.vault.getAbstractFileByPath(filename);
                if (file instanceof TFile) {
                    yield this.app.workspace.getLeaf().openFile(file);
                }
                return filename;
            }
            catch (error) {
                console.error('Error saving session:', error);
                throw error;
            }
        });
    }
    insertTrainingTemplate(editor) {
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
    research(topic, context = '') {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield this.apiRequest('/research', 'POST', {
                    topic,
                    context,
                    max_sources: 10
                });
                return response;
            }
            catch (error) {
                console.error('Research error:', error);
                throw error;
            }
        });
    }
    saveResearchToVault(topic, research) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Get markdown from sync endpoint
                const mdResponse = yield this.apiRequest('/sync/research', 'POST', {
                    topic,
                    article: research.article,
                    sources: research.sources,
                    context: research.context
                });
                // Ensure folder exists
                const folder = this.settings.syncFolder + '/Research';
                yield this.ensureFoldersExist([folder]);
                // Save file
                yield this.syncFile({
                    path: mdResponse.path,
                    content: mdResponse.content,
                    checksum: mdResponse.checksum
                });
                // Open the file
                const file = this.app.vault.getAbstractFileByPath(mdResponse.path);
                if (file instanceof TFile) {
                    yield this.app.workspace.getLeaf().openFile(file);
                }
                return mdResponse.path;
            }
            catch (error) {
                console.error('Error saving research:', error);
                throw error;
            }
        });
    }
}
// Flipmode Menu Modal
class FlipmodeMenuModal extends Modal {
    constructor(app, plugin) {
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
    constructor(app, plugin) {
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
    doResearch() {
        return __awaiter(this, void 0, void 0, function* () {
            const topic = this.topicInput.value.trim();
            if (!topic) {
                new Notice('Please enter a technique to research');
                return;
            }
            this.resultEl.empty();
            this.resultEl.createEl('p', { text: 'Searching Flipmode...' });
            try {
                const research = yield this.plugin.research(topic, this.contextInput.value);
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
                        .onClick(() => __awaiter(this, void 0, void 0, function* () {
                        try {
                            const path = yield this.plugin.saveResearchToVault(topic, research);
                            new Notice(`Saved to ${path}`);
                            this.close();
                        }
                        catch (error) {
                            new Notice('Failed to save research');
                        }
                    })));
                }
                else {
                    this.resultEl.createEl('p', {
                        text: 'No sources found. Try a different search term.'
                    });
                }
            }
            catch (error) {
                this.resultEl.empty();
                this.resultEl.createEl('p', {
                    text: 'Research failed. Check your connection settings.',
                    cls: 'error'
                });
            }
        });
    }
    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
// Voice Note Modal - Record training notes
class VoiceNoteModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.timerInterval = null;
        this.recordingStartTime = 0;
        this.plugin = plugin;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('flipmode-voice-modal');
        contentEl.createEl('h2', { text: '🎤 Record Training Note' });
        contentEl.createEl('p', {
            text: 'Record a voice note about your training session. Talk about what you worked on, what went well, what needs improvement.',
            cls: 'voice-instructions'
        });
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
        // Record button
        const btnContainer = contentEl.createDiv({ cls: 'voice-btn-container' });
        btnContainer.style.textAlign = 'center';
        btnContainer.style.margin = '20px 0';
        this.recordBtn = btnContainer.createEl('button', {
            text: '⏺ Start Recording',
            cls: 'mod-cta'
        });
        this.recordBtn.style.fontSize = '1.2em';
        this.recordBtn.style.padding = '15px 30px';
        this.recordBtn.onclick = () => this.toggleRecording();
        // Results area
        this.resultEl = contentEl.createDiv({ cls: 'voice-results' });
    }
    toggleRecording() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.isRecording) {
                yield this.stopRecording();
            }
            else {
                yield this.startRecording();
            }
        });
    }
    startRecording() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const stream = yield navigator.mediaDevices.getUserMedia({ audio: true });
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
                this.recordBtn.setText('⏹ Stop Recording');
                this.recordBtn.removeClass('mod-cta');
                this.recordBtn.addClass('mod-warning');
                this.statusEl.setText('Recording... speak now');
                this.statusEl.style.color = 'var(--text-error)';
                // Start timer
                this.timerInterval = window.setInterval(() => {
                    const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
                    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
                    const secs = (elapsed % 60).toString().padStart(2, '0');
                    this.timerEl.setText(`${mins}:${secs}`);
                }, 1000);
            }
            catch (error) {
                console.error('Recording error:', error);
                new Notice('Could not access microphone. Please allow microphone access.');
                this.statusEl.setText('Microphone access denied');
            }
        });
    }
    stopRecording() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.mediaRecorder && this.isRecording) {
                this.mediaRecorder.stop();
                this.isRecording = false;
                if (this.timerInterval) {
                    window.clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }
                this.recordBtn.setText('Processing...');
                this.recordBtn.disabled = true;
                this.statusEl.setText('Processing your voice note...');
                this.statusEl.style.color = 'var(--text-accent)';
            }
        });
    }
    processRecording() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Convert to base64
                const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                const base64 = yield this.blobToBase64(audioBlob);
                // Send to Flipmode
                this.statusEl.setText('Sending to Flipmode for analysis...');
                const session = yield this.plugin.startVoiceSession(base64);
                // Display results
                this.displayResults(session);
            }
            catch (error) {
                console.error('Processing error:', error);
                this.statusEl.setText('Error processing recording');
                this.statusEl.style.color = 'var(--text-error)';
                this.recordBtn.setText('⏺ Try Again');
                this.recordBtn.disabled = false;
                this.recordBtn.removeClass('mod-warning');
                this.recordBtn.addClass('mod-cta');
                this.resultEl.empty();
                this.resultEl.createEl('p', {
                    text: `Error: ${error.message || 'Could not process recording'}`,
                    cls: 'error'
                });
            }
        });
    }
    displayResults(session) {
        var _a, _b, _c;
        this.resultEl.empty();
        this.statusEl.setText('Playing response...');
        this.statusEl.style.color = 'var(--text-success)';
        // Play the audio response immediately
        if (session.response_audio_url) {
            const audioUrl = `${this.plugin.settings.serverUrl}${session.response_audio_url}`;
            const audio = new Audio(audioUrl);
            audio.play().catch(err => {
                console.error('Audio playback error:', err);
                new Notice('Could not play audio response');
            });
            // Audio player controls
            const audioContainer = this.resultEl.createDiv({ cls: 'audio-player' });
            audioContainer.style.textAlign = 'center';
            audioContainer.style.margin = '20px 0';
            audioContainer.style.padding = '15px';
            audioContainer.style.background = 'var(--background-secondary)';
            audioContainer.style.borderRadius = '8px';
            const playBtn = audioContainer.createEl('button', { text: '🔊 Replay Response' });
            playBtn.style.fontSize = '1.1em';
            playBtn.style.padding = '10px 20px';
            playBtn.style.marginRight = '10px';
            playBtn.onclick = () => {
                audio.currentTime = 0;
                audio.play();
            };
            const stopBtn = audioContainer.createEl('button', { text: '⏹ Stop' });
            stopBtn.style.padding = '10px 20px';
            stopBtn.onclick = () => audio.pause();
        }
        // Transcript (collapsed by default)
        const transcriptDetails = this.resultEl.createEl('details');
        transcriptDetails.style.marginTop = '20px';
        transcriptDetails.createEl('summary', { text: '📝 Your Notes (Transcribed)' });
        transcriptDetails.createEl('blockquote', { text: session.transcript });
        // Coach response text (collapsed by default)
        const responseDetails = this.resultEl.createEl('details');
        responseDetails.createEl('summary', { text: '💬 Coach Response (Text)' });
        responseDetails.createEl('p', { text: session.response_text });
        // Topics (collapsed by default)
        if (session.extracted_topics) {
            const topicsDetails = this.resultEl.createEl('details');
            topicsDetails.createEl('summary', { text: '🎯 Topics Identified' });
            const topicList = topicsDetails.createEl('ul');
            const topics = session.extracted_topics;
            if ((_a = topics.work_on) === null || _a === void 0 ? void 0 : _a.length) {
                for (const t of topics.work_on) {
                    topicList.createEl('li', { text: `Work on: ${t.topic}` });
                }
            }
            if ((_b = topics.wins) === null || _b === void 0 ? void 0 : _b.length) {
                for (const t of topics.wins) {
                    topicList.createEl('li', { text: `Win: ${t.topic}` });
                }
            }
        }
        // Options - these stay visible
        if ((_c = session.options) === null || _c === void 0 ? void 0 : _c.length) {
            this.resultEl.createEl('h3', { text: 'What would you like to do?' });
            const optContainer = this.resultEl.createDiv({ cls: 'option-buttons' });
            optContainer.style.display = 'flex';
            optContainer.style.flexWrap = 'wrap';
            optContainer.style.gap = '10px';
            optContainer.style.justifyContent = 'center';
            for (const opt of session.options) {
                const btn = optContainer.createEl('button', { text: opt.label });
                btn.style.padding = '10px 15px';
                btn.onclick = () => __awaiter(this, void 0, void 0, function* () {
                    new Notice(`Selected: ${opt.label}`);
                    // TODO: Continue conversation with selected option
                });
            }
        }
        // Save button
        const saveContainer = this.resultEl.createDiv();
        saveContainer.style.marginTop = '20px';
        saveContainer.style.textAlign = 'center';
        const saveBtn = saveContainer.createEl('button', {
            text: '💾 Save to Vault',
            cls: 'mod-cta'
        });
        saveBtn.style.fontSize = '1.1em';
        saveBtn.style.padding = '10px 20px';
        saveBtn.onclick = () => __awaiter(this, void 0, void 0, function* () {
            try {
                const path = yield this.plugin.saveSessionToVault(session);
                new Notice(`Saved to ${path}`);
                this.close();
            }
            catch (error) {
                new Notice('Failed to save session');
            }
        });
        // Reset record button
        this.recordBtn.setText('⏺ Record Another');
        this.recordBtn.disabled = false;
        this.recordBtn.removeClass('mod-warning');
        this.recordBtn.addClass('mod-cta');
    }
    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
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
// Settings Tab
class BJJFlipmodeSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Flipmode Settings' });
        // Server URL
        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('URL of your Flipmode server')
            .addText(text => text
            .setPlaceholder('http://localhost:5005')
            .setValue(this.plugin.settings.serverUrl)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.serverUrl = value;
            yield this.plugin.saveSettings();
        })));
        // API Token
        new Setting(containerEl)
            .setName('API Token')
            .setDesc('Your API token from the Flipmode profile page')
            .addText(text => text
            .setPlaceholder('Enter your API token')
            .setValue(this.plugin.settings.apiToken)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.apiToken = value;
            yield this.plugin.saveSettings();
        })));
        // Sync Folder
        new Setting(containerEl)
            .setName('Sync Folder')
            .setDesc('Folder in your vault for Flipmode content')
            .addText(text => text
            .setPlaceholder('Flipmode')
            .setValue(this.plugin.settings.syncFolder)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.syncFolder = value;
            yield this.plugin.saveSettings();
        })));
        // Auto Sync
        new Setting(containerEl)
            .setName('Auto Sync')
            .setDesc('Automatically sync with Flipmode periodically')
            .addToggle(toggle => toggle
            .setValue(this.plugin.settings.autoSync)
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.autoSync = value;
            yield this.plugin.saveSettings();
            if (value) {
                this.plugin.startAutoSync();
            }
        })));
        // Sync Interval
        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('Minutes between automatic syncs')
            .addSlider(slider => slider
            .setLimits(5, 120, 5)
            .setValue(this.plugin.settings.syncInterval)
            .setDynamicTooltip()
            .onChange((value) => __awaiter(this, void 0, void 0, function* () {
            this.plugin.settings.syncInterval = value;
            yield this.plugin.saveSettings();
        })));
        // Test Connection button
        new Setting(containerEl)
            .setName('Test Connection')
            .setDesc('Verify connection to Flipmode server')
            .addButton(btn => btn
            .setButtonText('Test')
            .onClick(() => __awaiter(this, void 0, void 0, function* () {
            const connected = yield this.plugin.checkConnection();
            new Notice(connected
                ? 'Successfully connected to Flipmode!'
                : 'Could not connect to Flipmode');
        })));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sRUFBNkIsS0FBSyxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsZ0JBQWdCLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBVyxVQUFVLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFZbkksTUFBTSxnQkFBZ0IsR0FBd0I7SUFDMUMsU0FBUyxFQUFFLHVCQUF1QjtJQUNsQyxRQUFRLEVBQUUsRUFBRTtJQUNaLFVBQVUsRUFBRSxVQUFVO0lBQ3RCLFFBQVEsRUFBRSxLQUFLO0lBQ2YsWUFBWSxFQUFFLEVBQUU7SUFDaEIsTUFBTSxFQUFFLFNBQVM7Q0FDcEIsQ0FBQztBQUVGLE1BQU0sQ0FBQyxPQUFPLE9BQU8saUJBQWtCLFNBQVEsTUFBTTtJQUFyRDs7UUFHSSxtQkFBYyxHQUFrQixJQUFJLENBQUM7SUFrWnpDLENBQUM7SUFoWlMsTUFBTTs7WUFDUixNQUFNLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztZQUUxQixzQkFBc0I7WUFDdEIsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztZQUM3QyxJQUFJLENBQUMsZUFBZSxDQUFDLGNBQWMsQ0FBQyxDQUFDO1lBRXJDLGtCQUFrQjtZQUNsQixJQUFJLENBQUMsYUFBYSxDQUFDLGVBQWUsRUFBRSxVQUFVLEVBQUUsR0FBUyxFQUFFO2dCQUN2RCxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1lBQ2xDLENBQUMsQ0FBQSxDQUFDLENBQUM7WUFFSCxlQUFlO1lBQ2YsSUFBSSxDQUFDLFVBQVUsQ0FBQztnQkFDWixFQUFFLEVBQUUscUJBQXFCO2dCQUN6QixJQUFJLEVBQUUsNEJBQTRCO2dCQUNsQyxRQUFRLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLGtCQUFrQixFQUFFO2FBQzVDLENBQUMsQ0FBQztZQUVILElBQUksQ0FBQyxV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QztJQUNoQixDQUFDO0NBQ0oiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBcHAsIEVkaXRvciwgTWFya2Rvd25WaWV3LCBNb2RhbCwgTm90aWNlLCBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIFRGaWxlLCBURm9sZGVyLCByZXF1ZXN0VXJsIH0gZnJvbSAnb2JzaWRpYW4nO1xuXG4vLyBQbHVnaW4gc2V0dGluZ3MgaW50ZXJmYWNlXG5pbnRlcmZhY2UgQkpKRmxpcG1vZGVTZXR0aW5ncyB7XG4gICAgc2VydmVyVXJsOiBzdHJpbmc7XG4gICAgYXBpVG9rZW46IHN0cmluZztcbiAgICBzeW5jRm9sZGVyOiBzdHJpbmc7XG4gICAgYXV0b1N5bmM6IGJvb2xlYW47XG4gICAgc3luY0ludGVydmFsOiBudW1iZXI7XG4gICAgdXNlcklkOiBzdHJpbmc7XG59XG5cbmNvbnN0IERFRkFVTFRfU0VUVElOR1M6IEJKSkZsaXBtb2RlU2V0dGluZ3MgPSB7XG4gICAgc2VydmVyVXJsOiAnaHR0cDovL2xvY2FsaG9zdDo1MDA1JyxcbiAgICBhcGlUb2tlbjogJycsXG4gICAgc3luY0ZvbGRlcjogJ0ZsaXBtb2RlJyxcbiAgICBhdXRvU3luYzogZmFsc2UsXG4gICAgc3luY0ludGVydmFsOiAzMCxcbiAgICB1c2VySWQ6ICdkZWZhdWx0J1xufTtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgQkpKRmxpcG1vZGVQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICAgIHNldHRpbmdzOiBCSkpGbGlwbW9kZVNldHRpbmdzO1xuICAgIHN0YXR1c0Jhckl0ZW06IEhUTUxFbGVtZW50O1xuICAgIHN5bmNJbnRlcnZhbElkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuICAgIGFzeW5jIG9ubG9hZCgpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuICAgICAgICAvLyBBZGQgc3RhdHVzIGJhciBpdGVtXG4gICAgICAgIHRoaXMuc3RhdHVzQmFySXRlbSA9IHRoaXMuYWRkU3RhdHVzQmFySXRlbSgpO1xuICAgICAgICB0aGlzLnVwZGF0ZVN0YXR1c0JhcignRGlzY29ubmVjdGVkJyk7XG5cbiAgICAgICAgLy8gQWRkIHJpYmJvbiBpY29uXG4gICAgICAgIHRoaXMuYWRkUmliYm9uSWNvbignYnJhaW4tY2lyY3VpdCcsICdGbGlwbW9kZScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuc2hvd0ZsaXBtb2RlTWVudSgpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBZGQgY29tbWFuZHNcbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnZmxpcG1vZGUtdm9pY2Utbm90ZScsXG4gICAgICAgICAgICBuYW1lOiAnUmVjb3JkIHRyYWluaW5nIHZvaWNlIG5vdGUnLFxuICAgICAgICAgICAgY2FsbGJhY2s6ICgpID0+IHRoaXMuc2hvd1ZvaWNlTm90ZU1vZGFsKClcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnZmxpcG1vZGUtcmVzZWFyY2gnLFxuICAgICAgICAgICAgbmFtZTogJ1Jlc2VhcmNoIGEgdGVjaG5pcXVlJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB0aGlzLnNob3dSZXNlYXJjaE1vZGFsKClcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnZmxpcG1vZGUtc3luYycsXG4gICAgICAgICAgICBuYW1lOiAnU3luYyB3aXRoIEZsaXBtb2RlJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB0aGlzLnN5bmNXaXRoRmxpcG1vZGUoKVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6ICdmbGlwbW9kZS1xdWljay1ub3RlJyxcbiAgICAgICAgICAgIG5hbWU6ICdRdWljayB0cmFpbmluZyBub3RlJyxcbiAgICAgICAgICAgIGVkaXRvckNhbGxiYWNrOiAoZWRpdG9yOiBFZGl0b3IsIHZpZXc6IE1hcmtkb3duVmlldykgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuaW5zZXJ0VHJhaW5pbmdUZW1wbGF0ZShlZGl0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6ICdmbGlwbW9kZS1jaGVjay1jb25uZWN0aW9uJyxcbiAgICAgICAgICAgIG5hbWU6ICdDaGVjayBGbGlwbW9kZSBjb25uZWN0aW9uJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB0aGlzLmNoZWNrQ29ubmVjdGlvbigpXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEFkZCBzZXR0aW5ncyB0YWJcbiAgICAgICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBCSkpGbGlwbW9kZVNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgICAgICAvLyBDaGVjayBjb25uZWN0aW9uIG9uIHN0YXJ0dXBcbiAgICAgICAgdGhpcy5jaGVja0Nvbm5lY3Rpb24oKTtcblxuICAgICAgICAvLyBTdGFydCBhdXRvLXN5bmMgaWYgZW5hYmxlZFxuICAgICAgICBpZiAodGhpcy5zZXR0aW5ncy5hdXRvU3luYykge1xuICAgICAgICAgICAgdGhpcy5zdGFydEF1dG9TeW5jKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBvbnVubG9hZCgpIHtcbiAgICAgICAgaWYgKHRoaXMuc3luY0ludGVydmFsSWQpIHtcbiAgICAgICAgICAgIHdpbmRvdy5jbGVhckludGVydmFsKHRoaXMuc3luY0ludGVydmFsSWQpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgICAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgYXdhaXQgdGhpcy5sb2FkRGF0YSgpKTtcbiAgICB9XG5cbiAgICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gICAgfVxuXG4gICAgdXBkYXRlU3RhdHVzQmFyKHN0YXR1czogc3RyaW5nKSB7XG4gICAgICAgIHRoaXMuc3RhdHVzQmFySXRlbS5zZXRUZXh0KGBGbGlwbW9kZTogJHtzdGF0dXN9YCk7XG4gICAgfVxuXG4gICAgLy8gQVBJIE1ldGhvZHNcbiAgICBhc3luYyBhcGlSZXF1ZXN0KGVuZHBvaW50OiBzdHJpbmcsIG1ldGhvZDogc3RyaW5nID0gJ0dFVCcsIGJvZHk/OiBhbnkpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBgJHt0aGlzLnNldHRpbmdzLnNlcnZlclVybH0vYXBpL29ic2lkaWFuJHtlbmRwb2ludH1gO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xuICAgICAgICAgICAgICAgIHVybCxcbiAgICAgICAgICAgICAgICBtZXRob2QsXG4gICAgICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHt0aGlzLnNldHRpbmdzLmFwaVRva2VufWBcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGJvZHk6IGJvZHkgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiByZXNwb25zZS5qc29uO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRmxpcG1vZGUgQVBJIGVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgY2hlY2tDb25uZWN0aW9uKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmFwaVJlcXVlc3QoJy9oZWFsdGgnKTtcbiAgICAgICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09ICdoZWFsdGh5Jykge1xuICAgICAgICAgICAgICAgIHRoaXMudXBkYXRlU3RhdHVzQmFyKCdDb25uZWN0ZWQnKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHRoaXMudXBkYXRlU3RhdHVzQmFyKCdEaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gU3luYyBNZXRob2RzXG4gICAgYXN5bmMgc3luY1dpdGhGbGlwbW9kZSgpIHtcbiAgICAgICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgdGhpcy5jaGVja0Nvbm5lY3Rpb24oKTtcbiAgICAgICAgaWYgKCFjb25uZWN0ZWQpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0Nhbm5vdCBjb25uZWN0IHRvIEZsaXBtb2RlIHNlcnZlcicpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgbmV3IE5vdGljZSgnU3luY2luZyB3aXRoIEZsaXBtb2RlLi4uJyk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIEdldCBzeW5jIG1hbmlmZXN0XG4gICAgICAgICAgICBjb25zdCB1c2VySWQgPSB0aGlzLnNldHRpbmdzLmFwaVRva2VuLnN1YnN0cmluZygwLCA4KSB8fCAnZGVmYXVsdCc7XG4gICAgICAgICAgICBjb25zdCBtYW5pZmVzdCA9IGF3YWl0IHRoaXMuYXBpUmVxdWVzdChgL3N5bmMvbWFuaWZlc3QvJHt1c2VySWR9YCk7XG5cbiAgICAgICAgICAgIC8vIEVuc3VyZSBkaXJlY3RvcmllcyBleGlzdFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVGb2xkZXJzRXhpc3QobWFuaWZlc3QuZGlyZWN0b3JpZXMpO1xuXG4gICAgICAgICAgICAvLyBTeW5jIGVhY2ggZmlsZVxuICAgICAgICAgICAgbGV0IHN5bmNlZENvdW50ID0gMDtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBtYW5pZmVzdC5maWxlcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHN5bmNlZCA9IGF3YWl0IHRoaXMuc3luY0ZpbGUoZmlsZSk7XG4gICAgICAgICAgICAgICAgaWYgKHN5bmNlZCkgc3luY2VkQ291bnQrKztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbmV3IE5vdGljZShgU3luY2VkICR7c3luY2VkQ291bnR9IGZpbGVzIGZyb20gRmxpcG1vZGVgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1N5bmMgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnU3luYyBmYWlsZWQgLSBjaGVjayBjb25zb2xlIGZvciBkZXRhaWxzJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBlbnN1cmVGb2xkZXJzRXhpc3QocGF0aHM6IHN0cmluZ1tdKSB7XG4gICAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgICAgICAgICAgY29uc3QgZm9sZGVyID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuICAgICAgICAgICAgaWYgKCFmb2xkZXIpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGVGb2xkZXIocGF0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBzeW5jRmlsZShmaWxlOiB7IHBhdGg6IHN0cmluZzsgY29udGVudDogc3RyaW5nOyBjaGVja3N1bTogc3RyaW5nIH0pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nRmlsZSA9IHRoaXMuYXBwLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChmaWxlLnBhdGgpO1xuXG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdGaWxlIGluc3RhbmNlb2YgVEZpbGUpIHtcbiAgICAgICAgICAgICAgICAvLyBDaGVjayBpZiBjb250ZW50IGNoYW5nZWRcbiAgICAgICAgICAgICAgICBjb25zdCBjdXJyZW50Q29udGVudCA9IGF3YWl0IHRoaXMuYXBwLnZhdWx0LnJlYWQoZXhpc3RpbmdGaWxlKTtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5jb21wdXRlQ2hlY2tzdW0oY3VycmVudENvbnRlbnQpICE9PSBmaWxlLmNoZWNrc3VtKSB7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeShleGlzdGluZ0ZpbGUsIGZpbGUuY29udGVudCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIENyZWF0ZSBuZXcgZmlsZVxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0LmNyZWF0ZShmaWxlLnBhdGgsIGZpbGUuY29udGVudCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvciBzeW5jaW5nIGZpbGUgJHtmaWxlLnBhdGh9OmAsIGVycm9yKTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNvbXB1dGVDaGVja3N1bShjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgICAgICAvLyBTaW1wbGUgY2hlY2tzdW0gLSBpbiBwcm9kdWN0aW9uIHVzZSBwcm9wZXIgaGFzaFxuICAgICAgICBsZXQgaGFzaCA9IDA7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY29udGVudC5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgY29uc3QgY2hhciA9IGNvbnRlbnQuY2hhckNvZGVBdChpKTtcbiAgICAgICAgICAgIGhhc2ggPSAoKGhhc2ggPDwgNSkgLSBoYXNoKSArIGNoYXI7XG4gICAgICAgICAgICBoYXNoID0gaGFzaCAmIGhhc2g7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGhhc2gudG9TdHJpbmcoMTYpLnN1YnN0cmluZygwLCAxNik7XG4gICAgfVxuXG4gICAgc3RhcnRBdXRvU3luYygpIHtcbiAgICAgICAgaWYgKHRoaXMuc3luY0ludGVydmFsSWQpIHtcbiAgICAgICAgICAgIHdpbmRvdy5jbGVhckludGVydmFsKHRoaXMuc3luY0ludGVydmFsSWQpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zeW5jSW50ZXJ2YWxJZCA9IHdpbmRvdy5zZXRJbnRlcnZhbChcbiAgICAgICAgICAgICgpID0+IHRoaXMuc3luY1dpdGhGbGlwbW9kZSgpLFxuICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5zeW5jSW50ZXJ2YWwgKiA2MCAqIDEwMDBcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBVSSBNZXRob2RzXG4gICAgYXN5bmMgc2hvd0ZsaXBtb2RlTWVudSgpIHtcbiAgICAgICAgbmV3IEZsaXBtb2RlTWVudU1vZGFsKHRoaXMuYXBwLCB0aGlzKS5vcGVuKCk7XG4gICAgfVxuXG4gICAgYXN5bmMgc2hvd1Jlc2VhcmNoTW9kYWwoKSB7XG4gICAgICAgIG5ldyBSZXNlYXJjaE1vZGFsKHRoaXMuYXBwLCB0aGlzKS5vcGVuKCk7XG4gICAgfVxuXG4gICAgYXN5bmMgc2hvd1ZvaWNlTm90ZU1vZGFsKCkge1xuICAgICAgICBuZXcgVm9pY2VOb3RlTW9kYWwodGhpcy5hcHAsIHRoaXMpLm9wZW4oKTtcbiAgICB9XG5cbiAgICAvLyBWb2ljZSBzZXNzaW9uIG1ldGhvZFxuICAgIGFzeW5jIHN0YXJ0Vm9pY2VTZXNzaW9uKGF1ZGlvQmFzZTY0OiBzdHJpbmcpOiBQcm9taXNlPGFueT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLmFwaVJlcXVlc3QoJy9zZXNzaW9uJywgJ1BPU1QnLCB7XG4gICAgICAgICAgICAgICAgdXNlcl9pZDogdGhpcy5zZXR0aW5ncy51c2VySWQsXG4gICAgICAgICAgICAgICAgYXVkaW9fYmFzZTY0OiBhdWRpb0Jhc2U2NCxcbiAgICAgICAgICAgICAgICBhdWRpb19mb3JtYXQ6ICd3ZWJtJ1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdWb2ljZSBzZXNzaW9uIGVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ29udGludWUgY29udmVyc2F0aW9uXG4gICAgYXN5bmMgcmVzcG9uZFRvU2Vzc2lvbihzZXNzaW9uSWQ6IHN0cmluZywgdGV4dD86IHN0cmluZywgYXVkaW9CYXNlNjQ/OiBzdHJpbmcsIHNlbGVjdGVkT3B0aW9uPzogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGJvZHk6IGFueSA9IHtcbiAgICAgICAgICAgICAgICBzZXNzaW9uX2lkOiBzZXNzaW9uSWQsXG4gICAgICAgICAgICAgICAgdXNlcl9pZDogdGhpcy5zZXR0aW5ncy51c2VySWRcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGlmIChhdWRpb0Jhc2U2NCkge1xuICAgICAgICAgICAgICAgIGJvZHkuYXVkaW9fYmFzZTY0ID0gYXVkaW9CYXNlNjQ7XG4gICAgICAgICAgICAgICAgYm9keS5hdWRpb19mb3JtYXQgPSAnd2VibSc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRleHQpIHtcbiAgICAgICAgICAgICAgICBib2R5LnRleHQgPSB0ZXh0O1xuICAgICAgICAgICAgfSBlbHNlIGlmIChzZWxlY3RlZE9wdGlvbikge1xuICAgICAgICAgICAgICAgIGJvZHkuc2VsZWN0ZWRfb3B0aW9uID0gc2VsZWN0ZWRPcHRpb247XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5hcGlSZXF1ZXN0KCcvcmVzcG9uZCcsICdQT1NUJywgYm9keSk7XG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdSZXNwb25kIGVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgc2F2ZVNlc3Npb25Ub1ZhdWx0KHNlc3Npb246IGFueSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zcGxpdCgnVCcpWzBdO1xuICAgICAgICAgICAgY29uc3QgZm9sZGVyID0gdGhpcy5zZXR0aW5ncy5zeW5jRm9sZGVyICsgJy9TZXNzaW9ucyc7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZUZvbGRlcnNFeGlzdChbZm9sZGVyXSk7XG5cbiAgICAgICAgICAgIC8vIEJ1aWxkIG1hcmtkb3duIGNvbnRlbnRcbiAgICAgICAgICAgIGxldCBjb250ZW50ID0gYC0tLVxudHlwZTogdHJhaW5pbmctc2Vzc2lvblxuZGF0ZTogJHtkYXRlfVxuc2Vzc2lvbl9pZDogJHtzZXNzaW9uLnNlc3Npb25faWR9XG50YWdzOiBbYmpqLCB0cmFpbmluZywgdm9pY2Utbm90ZV1cbi0tLVxuXG4jIFRyYWluaW5nIFNlc3Npb24gLSAke2RhdGV9XG5cbiMjIFlvdXIgTm90ZXMgKFRyYW5zY3JpYmVkKVxuXG4ke3Nlc3Npb24udHJhbnNjcmlwdH1cblxuIyMgVG9waWNzIElkZW50aWZpZWRcblxuYDtcbiAgICAgICAgICAgIC8vIEFkZCB0b3BpY3NcbiAgICAgICAgICAgIGlmIChzZXNzaW9uLmV4dHJhY3RlZF90b3BpY3MpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0b3BpY3MgPSBzZXNzaW9uLmV4dHJhY3RlZF90b3BpY3M7XG4gICAgICAgICAgICAgICAgaWYgKHRvcGljcy53b3JrX29uPy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGVudCArPSBgIyMjIFdvcmsgT25cXG5gO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHQgb2YgdG9waWNzLndvcmtfb24pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnQgKz0gYC0gKioke3QudG9waWN9Kio6ICR7dC5jb250ZXh0IHx8ICcnfVxcbmA7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgY29udGVudCArPSAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKHRvcGljcy53aW5zPy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGVudCArPSBgIyMjIFdpbnNcXG5gO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHQgb2YgdG9waWNzLndpbnMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnQgKz0gYC0gKioke3QudG9waWN9Kio6ICR7dC5jb250ZXh0IHx8ICcnfVxcbmA7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgY29udGVudCArPSAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRlbnQgKz0gYCMjIENvYWNoIFJlc3BvbnNlXG5cbiR7c2Vzc2lvbi5yZXNwb25zZV90ZXh0fVxuXG5gO1xuICAgICAgICAgICAgLy8gQWRkIG9wdGlvbnMgaWYgcHJlc2VudFxuICAgICAgICAgICAgaWYgKHNlc3Npb24ub3B0aW9ucz8ubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgY29udGVudCArPSBgIyMgTmV4dCBTdGVwc1xcblxcbmA7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBvcHQgb2Ygc2Vzc2lvbi5vcHRpb25zKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQgKz0gYC0gWyBdICR7b3B0LmxhYmVsfVxcbmA7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBmaWxlbmFtZSA9IGAke2ZvbGRlcn0vJHtkYXRlfS0ke3Nlc3Npb24uc2Vzc2lvbl9pZC5zdWJzdHJpbmcoMCwgOCl9Lm1kYDtcblxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdGaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGZpbGVuYW1lKTtcbiAgICAgICAgICAgIGlmIChleGlzdGluZ0ZpbGUgaW5zdGFuY2VvZiBURmlsZSkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwLnZhdWx0Lm1vZGlmeShleGlzdGluZ0ZpbGUsIGNvbnRlbnQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5jcmVhdGUoZmlsZW5hbWUsIGNvbnRlbnQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBPcGVuIHRoZSBmaWxlXG4gICAgICAgICAgICBjb25zdCBmaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGZpbGVuYW1lKTtcbiAgICAgICAgICAgIGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhZigpLm9wZW5GaWxlKGZpbGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZmlsZW5hbWU7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBzYXZpbmcgc2Vzc2lvbjonLCBlcnJvcik7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGluc2VydFRyYWluaW5nVGVtcGxhdGUoZWRpdG9yOiBFZGl0b3IpIHtcbiAgICAgICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKS5zcGxpdCgnVCcpWzBdO1xuICAgICAgICBjb25zdCB0ZW1wbGF0ZSA9IGAtLS1cbnR5cGU6IHRyYWluaW5nLW5vdGVcbmRhdGU6ICR7ZGF0ZX1cbnRhZ3M6IFtiamosIHRyYWluaW5nXVxuLS0tXG5cbiMgVHJhaW5pbmcgTm90ZXMgLSAke2RhdGV9XG5cbiMjIFdoYXQgV29ya2VkIFdlbGxcblxuXG4jIyBXaGF0IE5lZWRzIFdvcmtcblxuXG4jIyBUZWNobmlxdWVzIFByYWN0aWNlZFxuXG5cbiMjIFF1ZXN0aW9ucyBmb3IgRmxpcG1vZGVcblxuYDtcbiAgICAgICAgZWRpdG9yLnJlcGxhY2VTZWxlY3Rpb24odGVtcGxhdGUpO1xuICAgIH1cblxuICAgIC8vIFJlc2VhcmNoIG1ldGhvZFxuICAgIGFzeW5jIHJlc2VhcmNoKHRvcGljOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZyA9ICcnKTogUHJvbWlzZTxhbnk+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5hcGlSZXF1ZXN0KCcvcmVzZWFyY2gnLCAnUE9TVCcsIHtcbiAgICAgICAgICAgICAgICB0b3BpYyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgICAgIG1heF9zb3VyY2VzOiAxMFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1Jlc2VhcmNoIGVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgc2F2ZVJlc2VhcmNoVG9WYXVsdCh0b3BpYzogc3RyaW5nLCByZXNlYXJjaDogYW55KSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBHZXQgbWFya2Rvd24gZnJvbSBzeW5jIGVuZHBvaW50XG4gICAgICAgICAgICBjb25zdCBtZFJlc3BvbnNlID0gYXdhaXQgdGhpcy5hcGlSZXF1ZXN0KCcvc3luYy9yZXNlYXJjaCcsICdQT1NUJywge1xuICAgICAgICAgICAgICAgIHRvcGljLFxuICAgICAgICAgICAgICAgIGFydGljbGU6IHJlc2VhcmNoLmFydGljbGUsXG4gICAgICAgICAgICAgICAgc291cmNlczogcmVzZWFyY2guc291cmNlcyxcbiAgICAgICAgICAgICAgICBjb250ZXh0OiByZXNlYXJjaC5jb250ZXh0XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRW5zdXJlIGZvbGRlciBleGlzdHNcbiAgICAgICAgICAgIGNvbnN0IGZvbGRlciA9IHRoaXMuc2V0dGluZ3Muc3luY0ZvbGRlciArICcvUmVzZWFyY2gnO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVGb2xkZXJzRXhpc3QoW2ZvbGRlcl0pO1xuXG4gICAgICAgICAgICAvLyBTYXZlIGZpbGVcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuc3luY0ZpbGUoe1xuICAgICAgICAgICAgICAgIHBhdGg6IG1kUmVzcG9uc2UucGF0aCxcbiAgICAgICAgICAgICAgICBjb250ZW50OiBtZFJlc3BvbnNlLmNvbnRlbnQsXG4gICAgICAgICAgICAgICAgY2hlY2tzdW06IG1kUmVzcG9uc2UuY2hlY2tzdW1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBPcGVuIHRoZSBmaWxlXG4gICAgICAgICAgICBjb25zdCBmaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG1kUmVzcG9uc2UucGF0aCk7XG4gICAgICAgICAgICBpZiAoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYoKS5vcGVuRmlsZShmaWxlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG1kUmVzcG9uc2UucGF0aDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHNhdmluZyByZXNlYXJjaDonLCBlcnJvcik7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLy8gRmxpcG1vZGUgTWVudSBNb2RhbFxuY2xhc3MgRmxpcG1vZGVNZW51TW9kYWwgZXh0ZW5kcyBNb2RhbCB7XG4gICAgcGx1Z2luOiBCSkpGbGlwbW9kZVBsdWdpbjtcblxuICAgIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IEJKSkZsaXBtb2RlUGx1Z2luKSB7XG4gICAgICAgIHN1cGVyKGFwcCk7XG4gICAgICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIH1cblxuICAgIG9uT3BlbigpIHtcbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xuICAgICAgICBjb250ZW50RWwuYWRkQ2xhc3MoJ2ZsaXBtb2RlLW1vZGFsJyk7XG5cbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0ZsaXBtb2RlJyB9KTtcblxuICAgICAgICAvLyBDb25uZWN0aW9uIHN0YXR1c1xuICAgICAgICBjb25zdCBzdGF0dXNFbCA9IGNvbnRlbnRFbC5jcmVhdGVFbCgncCcsIHtcbiAgICAgICAgICAgIHRleHQ6ICdDaGVja2luZyBjb25uZWN0aW9uLi4uJyxcbiAgICAgICAgICAgIGNsczogJ2ZsaXBtb2RlLXN0YXR1cydcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5wbHVnaW4uY2hlY2tDb25uZWN0aW9uKCkudGhlbihjb25uZWN0ZWQgPT4ge1xuICAgICAgICAgICAgc3RhdHVzRWwuc2V0VGV4dChjb25uZWN0ZWQgPyAnQ29ubmVjdGVkIHRvIEZsaXBtb2RlJyA6ICdOb3QgY29ubmVjdGVkJyk7XG4gICAgICAgICAgICBzdGF0dXNFbC5hZGRDbGFzcyhjb25uZWN0ZWQgPyAnY29ubmVjdGVkJyA6ICdkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gTWVudSBidXR0b25zXG4gICAgICAgIGNvbnN0IGJ1dHRvbkNvbnRhaW5lciA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6ICdmbGlwbW9kZS1idXR0b25zJyB9KTtcblxuICAgICAgICBuZXcgU2V0dGluZyhidXR0b25Db250YWluZXIpXG4gICAgICAgICAgICAuc2V0TmFtZSgnUmVzZWFyY2ggVGVjaG5pcXVlJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdTZWFyY2ggdGhlIEZsaXBtb2RlIGZvciB0ZWNobmlxdWUgaW5mb3JtYXRpb24nKVxuICAgICAgICAgICAgLmFkZEJ1dHRvbihidG4gPT4gYnRuXG4gICAgICAgICAgICAgICAgLnNldEJ1dHRvblRleHQoJ1Jlc2VhcmNoJylcbiAgICAgICAgICAgICAgICAuc2V0Q3RhKClcbiAgICAgICAgICAgICAgICAub25DbGljaygoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2hvd1Jlc2VhcmNoTW9kYWwoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG5cbiAgICAgICAgbmV3IFNldHRpbmcoYnV0dG9uQ29udGFpbmVyKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1N5bmMgd2l0aCBGbGlwbW9kZScpXG4gICAgICAgICAgICAuc2V0RGVzYygnRG93bmxvYWQgbGF0ZXN0IHNlc3Npb25zIGFuZCBub3RlcycpXG4gICAgICAgICAgICAuYWRkQnV0dG9uKGJ0biA9PiBidG5cbiAgICAgICAgICAgICAgICAuc2V0QnV0dG9uVGV4dCgnU3luYycpXG4gICAgICAgICAgICAgICAgLm9uQ2xpY2soKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnN5bmNXaXRoRmxpcG1vZGUoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG5cbiAgICAgICAgbmV3IFNldHRpbmcoYnV0dG9uQ29udGFpbmVyKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1NldHRpbmdzJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdDb25maWd1cmUgRmxpcG1vZGUgY29ubmVjdGlvbicpXG4gICAgICAgICAgICAuYWRkQnV0dG9uKGJ0biA9PiBidG5cbiAgICAgICAgICAgICAgICAuc2V0QnV0dG9uVGV4dCgnT3BlbiBTZXR0aW5ncycpXG4gICAgICAgICAgICAgICAgLm9uQ2xpY2soKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5hcHAuc2V0dGluZy5vcGVuKCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5hcHAuc2V0dGluZy5vcGVuVGFiQnlJZCgnZmxpcG1vZGUnKTtcbiAgICAgICAgICAgICAgICB9KSk7XG4gICAgfVxuXG4gICAgb25DbG9zZSgpIHtcbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xuICAgIH1cbn1cblxuLy8gUmVzZWFyY2ggTW9kYWxcbmNsYXNzIFJlc2VhcmNoTW9kYWwgZXh0ZW5kcyBNb2RhbCB7XG4gICAgcGx1Z2luOiBCSkpGbGlwbW9kZVBsdWdpbjtcbiAgICB0b3BpY0lucHV0OiBIVE1MSW5wdXRFbGVtZW50O1xuICAgIGNvbnRleHRJbnB1dDogSFRNTFRleHRBcmVhRWxlbWVudDtcbiAgICByZXN1bHRFbDogSFRNTEVsZW1lbnQ7XG5cbiAgICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcGx1Z2luOiBCSkpGbGlwbW9kZVBsdWdpbikge1xuICAgICAgICBzdXBlcihhcHApO1xuICAgICAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICB9XG5cbiAgICBvbk9wZW4oKSB7XG4gICAgICAgIGNvbnN0IHsgY29udGVudEVsIH0gPSB0aGlzO1xuICAgICAgICBjb250ZW50RWwuZW1wdHkoKTtcbiAgICAgICAgY29udGVudEVsLmFkZENsYXNzKCdmbGlwbW9kZS1yZXNlYXJjaC1tb2RhbCcpO1xuXG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgnaDInLCB7IHRleHQ6ICdSZXNlYXJjaCBhIFRlY2huaXF1ZScgfSk7XG5cbiAgICAgICAgLy8gVG9waWMgaW5wdXRcbiAgICAgICAgbmV3IFNldHRpbmcoY29udGVudEVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1RlY2huaXF1ZScpXG4gICAgICAgICAgICAuc2V0RGVzYygnV2hhdCB0ZWNobmlxdWUgZG8geW91IHdhbnQgdG8gcmVzZWFyY2g/JylcbiAgICAgICAgICAgIC5hZGRUZXh0KHRleHQgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMudG9waWNJbnB1dCA9IHRleHQuaW5wdXRFbDtcbiAgICAgICAgICAgICAgICB0ZXh0LnNldFBsYWNlaG9sZGVyKCdlLmcuLCBrbmVlIHNsaWNlIHBhc3MsIGFybSBkcmFnLCBiZXJpbWJvbG8nKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIC8vIENvbnRleHQgaW5wdXRcbiAgICAgICAgbmV3IFNldHRpbmcoY29udGVudEVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ0NvbnRleHQgKG9wdGlvbmFsKScpXG4gICAgICAgICAgICAuc2V0RGVzYygnQW55IHNwZWNpZmljIHNpdHVhdGlvbiBvciBwcm9ibGVtPycpXG4gICAgICAgICAgICAuYWRkVGV4dEFyZWEodGV4dCA9PiB7XG4gICAgICAgICAgICAgICAgdGhpcy5jb250ZXh0SW5wdXQgPSB0ZXh0LmlucHV0RWw7XG4gICAgICAgICAgICAgICAgdGV4dC5zZXRQbGFjZWhvbGRlcignZS5nLiwgZGVmZW5kaW5nIGFnYWluc3QgaXQsIGZyb20gY2xvc2VkIGd1YXJkLCBhZ2FpbnN0IGJpZ2dlciBvcHBvbmVudHMnKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFNlYXJjaCBidXR0b25cbiAgICAgICAgbmV3IFNldHRpbmcoY29udGVudEVsKVxuICAgICAgICAgICAgLmFkZEJ1dHRvbihidG4gPT4gYnRuXG4gICAgICAgICAgICAgICAgLnNldEJ1dHRvblRleHQoJ1NlYXJjaCBGbGlwbW9kZScpXG4gICAgICAgICAgICAgICAgLnNldEN0YSgpXG4gICAgICAgICAgICAgICAgLm9uQ2xpY2soKCkgPT4gdGhpcy5kb1Jlc2VhcmNoKCkpKTtcblxuICAgICAgICAvLyBSZXN1bHRzIGFyZWFcbiAgICAgICAgdGhpcy5yZXN1bHRFbCA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6ICdmbGlwbW9kZS1yZXN1bHRzJyB9KTtcbiAgICB9XG5cbiAgICBhc3luYyBkb1Jlc2VhcmNoKCkge1xuICAgICAgICBjb25zdCB0b3BpYyA9IHRoaXMudG9waWNJbnB1dC52YWx1ZS50cmltKCk7XG4gICAgICAgIGlmICghdG9waWMpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ1BsZWFzZSBlbnRlciBhIHRlY2huaXF1ZSB0byByZXNlYXJjaCcpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5yZXN1bHRFbC5lbXB0eSgpO1xuICAgICAgICB0aGlzLnJlc3VsdEVsLmNyZWF0ZUVsKCdwJywgeyB0ZXh0OiAnU2VhcmNoaW5nIEZsaXBtb2RlLi4uJyB9KTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzZWFyY2ggPSBhd2FpdCB0aGlzLnBsdWdpbi5yZXNlYXJjaCh0b3BpYywgdGhpcy5jb250ZXh0SW5wdXQudmFsdWUpO1xuXG4gICAgICAgICAgICB0aGlzLnJlc3VsdEVsLmVtcHR5KCk7XG5cbiAgICAgICAgICAgIGlmIChyZXNlYXJjaC5zb3VyY2VfY291bnQgPiAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5yZXN1bHRFbC5jcmVhdGVFbCgnaDMnLCB7XG4gICAgICAgICAgICAgICAgICAgIHRleHQ6IGBGb3VuZCAke3Jlc2VhcmNoLnNvdXJjZV9jb3VudH0gc291cmNlc2BcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIC8vIFByZXZpZXdcbiAgICAgICAgICAgICAgICBjb25zdCBwcmV2aWV3RWwgPSB0aGlzLnJlc3VsdEVsLmNyZWF0ZUVsKCdkaXYnLCB7IGNsczogJ3Jlc2VhcmNoLXByZXZpZXcnIH0pO1xuICAgICAgICAgICAgICAgIHByZXZpZXdFbC5jcmVhdGVFbCgncCcsIHtcbiAgICAgICAgICAgICAgICAgICAgdGV4dDogcmVzZWFyY2guYXJ0aWNsZS5zdWJzdHJpbmcoMCwgMzAwKSArICcuLi4nXG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvLyBTb3VyY2VzIGxpc3RcbiAgICAgICAgICAgICAgICBjb25zdCBzb3VyY2VzTGlzdCA9IHRoaXMucmVzdWx0RWwuY3JlYXRlRWwoJ3VsJywgeyBjbHM6ICdzb3VyY2VzLWxpc3QnIH0pO1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHJlc2VhcmNoLnNvdXJjZXMuc2xpY2UoMCwgNSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc291cmNlc0xpc3QuY3JlYXRlRWwoJ2xpJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGV4dDogYCR7c291cmNlLmluc3RydWN0b3J9IC0gJHtzb3VyY2UudGl0bGV9YFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvLyBTYXZlIGJ1dHRvblxuICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHRoaXMucmVzdWx0RWwpXG4gICAgICAgICAgICAgICAgICAgIC5hZGRCdXR0b24oYnRuID0+IGJ0blxuICAgICAgICAgICAgICAgICAgICAgICAgLnNldEJ1dHRvblRleHQoJ1NhdmUgdG8gVmF1bHQnKVxuICAgICAgICAgICAgICAgICAgICAgICAgLnNldEN0YSgpXG4gICAgICAgICAgICAgICAgICAgICAgICAub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcGF0aCA9IGF3YWl0IHRoaXMucGx1Z2luLnNhdmVSZXNlYXJjaFRvVmF1bHQodG9waWMsIHJlc2VhcmNoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmV3IE5vdGljZShgU2F2ZWQgdG8gJHtwYXRofWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbmV3IE5vdGljZSgnRmFpbGVkIHRvIHNhdmUgcmVzZWFyY2gnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMucmVzdWx0RWwuY3JlYXRlRWwoJ3AnLCB7XG4gICAgICAgICAgICAgICAgICAgIHRleHQ6ICdObyBzb3VyY2VzIGZvdW5kLiBUcnkgYSBkaWZmZXJlbnQgc2VhcmNoIHRlcm0uJ1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgdGhpcy5yZXN1bHRFbC5lbXB0eSgpO1xuICAgICAgICAgICAgdGhpcy5yZXN1bHRFbC5jcmVhdGVFbCgncCcsIHtcbiAgICAgICAgICAgICAgICB0ZXh0OiAnUmVzZWFyY2ggZmFpbGVkLiBDaGVjayB5b3VyIGNvbm5lY3Rpb24gc2V0dGluZ3MuJyxcbiAgICAgICAgICAgICAgICBjbHM6ICdlcnJvcidcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgb25DbG9zZSgpIHtcbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xuICAgIH1cbn1cblxuLy8gVm9pY2UgTm90ZSBNb2RhbCAtIFJlY29yZCB0cmFpbmluZyBub3Rlc1xuY2xhc3MgVm9pY2VOb3RlTW9kYWwgZXh0ZW5kcyBNb2RhbCB7XG4gICAgcGx1Z2luOiBCSkpGbGlwbW9kZVBsdWdpbjtcbiAgICBtZWRpYVJlY29yZGVyOiBNZWRpYVJlY29yZGVyIHwgbnVsbCA9IG51bGw7XG4gICAgYXVkaW9DaHVua3M6IEJsb2JbXSA9IFtdO1xuICAgIGlzUmVjb3JkaW5nOiBib29sZWFuID0gZmFsc2U7XG4gICAgcmVjb3JkQnRuOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgICBzdGF0dXNFbDogSFRNTEVsZW1lbnQ7XG4gICAgcmVzdWx0RWw6IEhUTUxFbGVtZW50O1xuICAgIHRpbWVyRWw6IEhUTUxFbGVtZW50O1xuICAgIHRpbWVySW50ZXJ2YWw6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIHJlY29yZGluZ1N0YXJ0VGltZTogbnVtYmVyID0gMDtcblxuICAgIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IEJKSkZsaXBtb2RlUGx1Z2luKSB7XG4gICAgICAgIHN1cGVyKGFwcCk7XG4gICAgICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICAgIH1cblxuICAgIG9uT3BlbigpIHtcbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xuICAgICAgICBjb250ZW50RWwuYWRkQ2xhc3MoJ2ZsaXBtb2RlLXZvaWNlLW1vZGFsJyk7XG5cbiAgICAgICAgY29udGVudEVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ/CfjqQgUmVjb3JkIFRyYWluaW5nIE5vdGUnIH0pO1xuXG4gICAgICAgIGNvbnRlbnRFbC5jcmVhdGVFbCgncCcsIHtcbiAgICAgICAgICAgIHRleHQ6ICdSZWNvcmQgYSB2b2ljZSBub3RlIGFib3V0IHlvdXIgdHJhaW5pbmcgc2Vzc2lvbi4gVGFsayBhYm91dCB3aGF0IHlvdSB3b3JrZWQgb24sIHdoYXQgd2VudCB3ZWxsLCB3aGF0IG5lZWRzIGltcHJvdmVtZW50LicsXG4gICAgICAgICAgICBjbHM6ICd2b2ljZS1pbnN0cnVjdGlvbnMnXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFRpbWVyIGRpc3BsYXlcbiAgICAgICAgdGhpcy50aW1lckVsID0gY29udGVudEVsLmNyZWF0ZUVsKCdkaXYnLCB7XG4gICAgICAgICAgICB0ZXh0OiAnMDA6MDAnLFxuICAgICAgICAgICAgY2xzOiAndm9pY2UtdGltZXInXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLnRpbWVyRWwuc3R5bGUuZm9udFNpemUgPSAnMmVtJztcbiAgICAgICAgdGhpcy50aW1lckVsLnN0eWxlLnRleHRBbGlnbiA9ICdjZW50ZXInO1xuICAgICAgICB0aGlzLnRpbWVyRWwuc3R5bGUubWFyZ2luID0gJzIwcHggMCc7XG4gICAgICAgIHRoaXMudGltZXJFbC5zdHlsZS5mb250RmFtaWx5ID0gJ21vbm9zcGFjZSc7XG5cbiAgICAgICAgLy8gU3RhdHVzXG4gICAgICAgIHRoaXMuc3RhdHVzRWwgPSBjb250ZW50RWwuY3JlYXRlRWwoJ3AnLCB7XG4gICAgICAgICAgICB0ZXh0OiAnQ2xpY2sgdG8gc3RhcnQgcmVjb3JkaW5nJyxcbiAgICAgICAgICAgIGNsczogJ3ZvaWNlLXN0YXR1cydcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuc3RhdHVzRWwuc3R5bGUudGV4dEFsaWduID0gJ2NlbnRlcic7XG4gICAgICAgIHRoaXMuc3RhdHVzRWwuc3R5bGUuY29sb3IgPSAndmFyKC0tdGV4dC1tdXRlZCknO1xuXG4gICAgICAgIC8vIFJlY29yZCBidXR0b25cbiAgICAgICAgY29uc3QgYnRuQ29udGFpbmVyID0gY29udGVudEVsLmNyZWF0ZURpdih7IGNsczogJ3ZvaWNlLWJ0bi1jb250YWluZXInIH0pO1xuICAgICAgICBidG5Db250YWluZXIuc3R5bGUudGV4dEFsaWduID0gJ2NlbnRlcic7XG4gICAgICAgIGJ0bkNvbnRhaW5lci5zdHlsZS5tYXJnaW4gPSAnMjBweCAwJztcblxuICAgICAgICB0aGlzLnJlY29yZEJ0biA9IGJ0bkNvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywge1xuICAgICAgICAgICAgdGV4dDogJ+KPuiBTdGFydCBSZWNvcmRpbmcnLFxuICAgICAgICAgICAgY2xzOiAnbW9kLWN0YSdcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMucmVjb3JkQnRuLnN0eWxlLmZvbnRTaXplID0gJzEuMmVtJztcbiAgICAgICAgdGhpcy5yZWNvcmRCdG4uc3R5bGUucGFkZGluZyA9ICcxNXB4IDMwcHgnO1xuICAgICAgICB0aGlzLnJlY29yZEJ0bi5vbmNsaWNrID0gKCkgPT4gdGhpcy50b2dnbGVSZWNvcmRpbmcoKTtcblxuICAgICAgICAvLyBSZXN1bHRzIGFyZWFcbiAgICAgICAgdGhpcy5yZXN1bHRFbCA9IGNvbnRlbnRFbC5jcmVhdGVEaXYoeyBjbHM6ICd2b2ljZS1yZXN1bHRzJyB9KTtcbiAgICB9XG5cbiAgICBhc3luYyB0b2dnbGVSZWNvcmRpbmcoKSB7XG4gICAgICAgIGlmICh0aGlzLmlzUmVjb3JkaW5nKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnN0b3BSZWNvcmRpbmcoKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuc3RhcnRSZWNvcmRpbmcoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHN0YXJ0UmVjb3JkaW5nKCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5nZXRVc2VyTWVkaWEoeyBhdWRpbzogdHJ1ZSB9KTtcblxuICAgICAgICAgICAgdGhpcy5hdWRpb0NodW5rcyA9IFtdO1xuICAgICAgICAgICAgdGhpcy5tZWRpYVJlY29yZGVyID0gbmV3IE1lZGlhUmVjb3JkZXIoc3RyZWFtLCB7XG4gICAgICAgICAgICAgICAgbWltZVR5cGU6ICdhdWRpby93ZWJtO2NvZGVjcz1vcHVzJ1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHRoaXMubWVkaWFSZWNvcmRlci5vbmRhdGFhdmFpbGFibGUgPSAoZXZlbnQpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXZlbnQuZGF0YS5zaXplID4gMCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmF1ZGlvQ2h1bmtzLnB1c2goZXZlbnQuZGF0YSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgdGhpcy5tZWRpYVJlY29yZGVyLm9uc3RvcCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaCh0cmFjayA9PiB0cmFjay5zdG9wKCkpO1xuICAgICAgICAgICAgICAgIHRoaXMucHJvY2Vzc1JlY29yZGluZygpO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgdGhpcy5tZWRpYVJlY29yZGVyLnN0YXJ0KDEwMDApOyAvLyBDb2xsZWN0IGRhdGEgZXZlcnkgc2Vjb25kXG4gICAgICAgICAgICB0aGlzLmlzUmVjb3JkaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMucmVjb3JkaW5nU3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICAgICAgICAgICAgdGhpcy5yZWNvcmRCdG4uc2V0VGV4dCgn4o+5IFN0b3AgUmVjb3JkaW5nJyk7XG4gICAgICAgICAgICB0aGlzLnJlY29yZEJ0bi5yZW1vdmVDbGFzcygnbW9kLWN0YScpO1xuICAgICAgICAgICAgdGhpcy5yZWNvcmRCdG4uYWRkQ2xhc3MoJ21vZC13YXJuaW5nJyk7XG4gICAgICAgICAgICB0aGlzLnN0YXR1c0VsLnNldFRleHQoJ1JlY29yZGluZy4uLiBzcGVhayBub3cnKTtcbiAgICAgICAgICAgIHRoaXMuc3RhdHVzRWwuc3R5bGUuY29sb3IgPSAndmFyKC0tdGV4dC1lcnJvciknO1xuXG4gICAgICAgICAgICAvLyBTdGFydCB0aW1lclxuICAgICAgICAgICAgdGhpcy50aW1lckludGVydmFsID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBlbGFwc2VkID0gTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIHRoaXMucmVjb3JkaW5nU3RhcnRUaW1lKSAvIDEwMDApO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1pbnMgPSBNYXRoLmZsb29yKGVsYXBzZWQgLyA2MCkudG9TdHJpbmcoKS5wYWRTdGFydCgyLCAnMCcpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHNlY3MgPSAoZWxhcHNlZCAlIDYwKS50b1N0cmluZygpLnBhZFN0YXJ0KDIsICcwJyk7XG4gICAgICAgICAgICAgICAgdGhpcy50aW1lckVsLnNldFRleHQoYCR7bWluc306JHtzZWNzfWApO1xuICAgICAgICAgICAgfSwgMTAwMCk7XG5cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1JlY29yZGluZyBlcnJvcjonLCBlcnJvcik7XG4gICAgICAgICAgICBuZXcgTm90aWNlKCdDb3VsZCBub3QgYWNjZXNzIG1pY3JvcGhvbmUuIFBsZWFzZSBhbGxvdyBtaWNyb3Bob25lIGFjY2Vzcy4nKTtcbiAgICAgICAgICAgIHRoaXMuc3RhdHVzRWwuc2V0VGV4dCgnTWljcm9waG9uZSBhY2Nlc3MgZGVuaWVkJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBzdG9wUmVjb3JkaW5nKCkge1xuICAgICAgICBpZiAodGhpcy5tZWRpYVJlY29yZGVyICYmIHRoaXMuaXNSZWNvcmRpbmcpIHtcbiAgICAgICAgICAgIHRoaXMubWVkaWFSZWNvcmRlci5zdG9wKCk7XG4gICAgICAgICAgICB0aGlzLmlzUmVjb3JkaW5nID0gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLnRpbWVySW50ZXJ2YWwpIHtcbiAgICAgICAgICAgICAgICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aGlzLnRpbWVySW50ZXJ2YWwpO1xuICAgICAgICAgICAgICAgIHRoaXMudGltZXJJbnRlcnZhbCA9IG51bGw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMucmVjb3JkQnRuLnNldFRleHQoJ1Byb2Nlc3NpbmcuLi4nKTtcbiAgICAgICAgICAgIHRoaXMucmVjb3JkQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuc3RhdHVzRWwuc2V0VGV4dCgnUHJvY2Vzc2luZyB5b3VyIHZvaWNlIG5vdGUuLi4nKTtcbiAgICAgICAgICAgIHRoaXMuc3RhdHVzRWwuc3R5bGUuY29sb3IgPSAndmFyKC0tdGV4dC1hY2NlbnQpJztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHByb2Nlc3NSZWNvcmRpbmcoKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBDb252ZXJ0IHRvIGJhc2U2NFxuICAgICAgICAgICAgY29uc3QgYXVkaW9CbG9iID0gbmV3IEJsb2IodGhpcy5hdWRpb0NodW5rcywgeyB0eXBlOiAnYXVkaW8vd2VibScgfSk7XG4gICAgICAgICAgICBjb25zdCBiYXNlNjQgPSBhd2FpdCB0aGlzLmJsb2JUb0Jhc2U2NChhdWRpb0Jsb2IpO1xuXG4gICAgICAgICAgICAvLyBTZW5kIHRvIEZsaXBtb2RlXG4gICAgICAgICAgICB0aGlzLnN0YXR1c0VsLnNldFRleHQoJ1NlbmRpbmcgdG8gRmxpcG1vZGUgZm9yIGFuYWx5c2lzLi4uJyk7XG4gICAgICAgICAgICBjb25zdCBzZXNzaW9uID0gYXdhaXQgdGhpcy5wbHVnaW4uc3RhcnRWb2ljZVNlc3Npb24oYmFzZTY0KTtcblxuICAgICAgICAgICAgLy8gRGlzcGxheSByZXN1bHRzXG4gICAgICAgICAgICB0aGlzLmRpc3BsYXlSZXN1bHRzKHNlc3Npb24pO1xuXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdQcm9jZXNzaW5nIGVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIHRoaXMuc3RhdHVzRWwuc2V0VGV4dCgnRXJyb3IgcHJvY2Vzc2luZyByZWNvcmRpbmcnKTtcbiAgICAgICAgICAgIHRoaXMuc3RhdHVzRWwuc3R5bGUuY29sb3IgPSAndmFyKC0tdGV4dC1lcnJvciknO1xuICAgICAgICAgICAgdGhpcy5yZWNvcmRCdG4uc2V0VGV4dCgn4o+6IFRyeSBBZ2FpbicpO1xuICAgICAgICAgICAgdGhpcy5yZWNvcmRCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIHRoaXMucmVjb3JkQnRuLnJlbW92ZUNsYXNzKCdtb2Qtd2FybmluZycpO1xuICAgICAgICAgICAgdGhpcy5yZWNvcmRCdG4uYWRkQ2xhc3MoJ21vZC1jdGEnKTtcblxuICAgICAgICAgICAgdGhpcy5yZXN1bHRFbC5lbXB0eSgpO1xuICAgICAgICAgICAgdGhpcy5yZXN1bHRFbC5jcmVhdGVFbCgncCcsIHtcbiAgICAgICAgICAgICAgICB0ZXh0OiBgRXJyb3I6ICR7ZXJyb3IubWVzc2FnZSB8fCAnQ291bGQgbm90IHByb2Nlc3MgcmVjb3JkaW5nJ31gLFxuICAgICAgICAgICAgICAgIGNsczogJ2Vycm9yJ1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBkaXNwbGF5UmVzdWx0cyhzZXNzaW9uOiBhbnkpIHtcbiAgICAgICAgdGhpcy5yZXN1bHRFbC5lbXB0eSgpO1xuICAgICAgICB0aGlzLnN0YXR1c0VsLnNldFRleHQoJ1BsYXlpbmcgcmVzcG9uc2UuLi4nKTtcbiAgICAgICAgdGhpcy5zdGF0dXNFbC5zdHlsZS5jb2xvciA9ICd2YXIoLS10ZXh0LXN1Y2Nlc3MpJztcblxuICAgICAgICAvLyBQbGF5IHRoZSBhdWRpbyByZXNwb25zZSBpbW1lZGlhdGVseVxuICAgICAgICBpZiAoc2Vzc2lvbi5yZXNwb25zZV9hdWRpb191cmwpIHtcbiAgICAgICAgICAgIGNvbnN0IGF1ZGlvVXJsID0gYCR7dGhpcy5wbHVnaW4uc2V0dGluZ3Muc2VydmVyVXJsfSR7c2Vzc2lvbi5yZXNwb25zZV9hdWRpb191cmx9YDtcbiAgICAgICAgICAgIGNvbnN0IGF1ZGlvID0gbmV3IEF1ZGlvKGF1ZGlvVXJsKTtcbiAgICAgICAgICAgIGF1ZGlvLnBsYXkoKS5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0F1ZGlvIHBsYXliYWNrIGVycm9yOicsIGVycik7XG4gICAgICAgICAgICAgICAgbmV3IE5vdGljZSgnQ291bGQgbm90IHBsYXkgYXVkaW8gcmVzcG9uc2UnKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBBdWRpbyBwbGF5ZXIgY29udHJvbHNcbiAgICAgICAgICAgIGNvbnN0IGF1ZGlvQ29udGFpbmVyID0gdGhpcy5yZXN1bHRFbC5jcmVhdGVEaXYoeyBjbHM6ICdhdWRpby1wbGF5ZXInIH0pO1xuICAgICAgICAgICAgYXVkaW9Db250YWluZXIuc3R5bGUudGV4dEFsaWduID0gJ2NlbnRlcic7XG4gICAgICAgICAgICBhdWRpb0NvbnRhaW5lci5zdHlsZS5tYXJnaW4gPSAnMjBweCAwJztcbiAgICAgICAgICAgIGF1ZGlvQ29udGFpbmVyLnN0eWxlLnBhZGRpbmcgPSAnMTVweCc7XG4gICAgICAgICAgICBhdWRpb0NvbnRhaW5lci5zdHlsZS5iYWNrZ3JvdW5kID0gJ3ZhcigtLWJhY2tncm91bmQtc2Vjb25kYXJ5KSc7XG4gICAgICAgICAgICBhdWRpb0NvbnRhaW5lci5zdHlsZS5ib3JkZXJSYWRpdXMgPSAnOHB4JztcblxuICAgICAgICAgICAgY29uc3QgcGxheUJ0biA9IGF1ZGlvQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7IHRleHQ6ICfwn5SKIFJlcGxheSBSZXNwb25zZScgfSk7XG4gICAgICAgICAgICBwbGF5QnRuLnN0eWxlLmZvbnRTaXplID0gJzEuMWVtJztcbiAgICAgICAgICAgIHBsYXlCdG4uc3R5bGUucGFkZGluZyA9ICcxMHB4IDIwcHgnO1xuICAgICAgICAgICAgcGxheUJ0bi5zdHlsZS5tYXJnaW5SaWdodCA9ICcxMHB4JztcbiAgICAgICAgICAgIHBsYXlCdG4ub25jbGljayA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBhdWRpby5jdXJyZW50VGltZSA9IDA7XG4gICAgICAgICAgICAgICAgYXVkaW8ucGxheSgpO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgY29uc3Qgc3RvcEJ0biA9IGF1ZGlvQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7IHRleHQ6ICfij7kgU3RvcCcgfSk7XG4gICAgICAgICAgICBzdG9wQnRuLnN0eWxlLnBhZGRpbmcgPSAnMTBweCAyMHB4JztcbiAgICAgICAgICAgIHN0b3BCdG4ub25jbGljayA9ICgpID0+IGF1ZGlvLnBhdXNlKCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBUcmFuc2NyaXB0IChjb2xsYXBzZWQgYnkgZGVmYXVsdClcbiAgICAgICAgY29uc3QgdHJhbnNjcmlwdERldGFpbHMgPSB0aGlzLnJlc3VsdEVsLmNyZWF0ZUVsKCdkZXRhaWxzJyk7XG4gICAgICAgIHRyYW5zY3JpcHREZXRhaWxzLnN0eWxlLm1hcmdpblRvcCA9ICcyMHB4JztcbiAgICAgICAgdHJhbnNjcmlwdERldGFpbHMuY3JlYXRlRWwoJ3N1bW1hcnknLCB7IHRleHQ6ICfwn5OdIFlvdXIgTm90ZXMgKFRyYW5zY3JpYmVkKScgfSk7XG4gICAgICAgIHRyYW5zY3JpcHREZXRhaWxzLmNyZWF0ZUVsKCdibG9ja3F1b3RlJywgeyB0ZXh0OiBzZXNzaW9uLnRyYW5zY3JpcHQgfSk7XG5cbiAgICAgICAgLy8gQ29hY2ggcmVzcG9uc2UgdGV4dCAoY29sbGFwc2VkIGJ5IGRlZmF1bHQpXG4gICAgICAgIGNvbnN0IHJlc3BvbnNlRGV0YWlscyA9IHRoaXMucmVzdWx0RWwuY3JlYXRlRWwoJ2RldGFpbHMnKTtcbiAgICAgICAgcmVzcG9uc2VEZXRhaWxzLmNyZWF0ZUVsKCdzdW1tYXJ5JywgeyB0ZXh0OiAn8J+SrCBDb2FjaCBSZXNwb25zZSAoVGV4dCknIH0pO1xuICAgICAgICByZXNwb25zZURldGFpbHMuY3JlYXRlRWwoJ3AnLCB7IHRleHQ6IHNlc3Npb24ucmVzcG9uc2VfdGV4dCB9KTtcblxuICAgICAgICAvLyBUb3BpY3MgKGNvbGxhcHNlZCBieSBkZWZhdWx0KVxuICAgICAgICBpZiAoc2Vzc2lvbi5leHRyYWN0ZWRfdG9waWNzKSB7XG4gICAgICAgICAgICBjb25zdCB0b3BpY3NEZXRhaWxzID0gdGhpcy5yZXN1bHRFbC5jcmVhdGVFbCgnZGV0YWlscycpO1xuICAgICAgICAgICAgdG9waWNzRGV0YWlscy5jcmVhdGVFbCgnc3VtbWFyeScsIHsgdGV4dDogJ/Cfjq8gVG9waWNzIElkZW50aWZpZWQnIH0pO1xuICAgICAgICAgICAgY29uc3QgdG9waWNMaXN0ID0gdG9waWNzRGV0YWlscy5jcmVhdGVFbCgndWwnKTtcblxuICAgICAgICAgICAgY29uc3QgdG9waWNzID0gc2Vzc2lvbi5leHRyYWN0ZWRfdG9waWNzO1xuICAgICAgICAgICAgaWYgKHRvcGljcy53b3JrX29uPy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHQgb2YgdG9waWNzLndvcmtfb24pIHtcbiAgICAgICAgICAgICAgICAgICAgdG9waWNMaXN0LmNyZWF0ZUVsKCdsaScsIHsgdGV4dDogYFdvcmsgb246ICR7dC50b3BpY31gIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0b3BpY3Mud2lucz8ubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCB0IG9mIHRvcGljcy53aW5zKSB7XG4gICAgICAgICAgICAgICAgICAgIHRvcGljTGlzdC5jcmVhdGVFbCgnbGknLCB7IHRleHQ6IGBXaW46ICR7dC50b3BpY31gIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIE9wdGlvbnMgLSB0aGVzZSBzdGF5IHZpc2libGVcbiAgICAgICAgaWYgKHNlc3Npb24ub3B0aW9ucz8ubGVuZ3RoKSB7XG4gICAgICAgICAgICB0aGlzLnJlc3VsdEVsLmNyZWF0ZUVsKCdoMycsIHsgdGV4dDogJ1doYXQgd291bGQgeW91IGxpa2UgdG8gZG8/JyB9KTtcbiAgICAgICAgICAgIGNvbnN0IG9wdENvbnRhaW5lciA9IHRoaXMucmVzdWx0RWwuY3JlYXRlRGl2KHsgY2xzOiAnb3B0aW9uLWJ1dHRvbnMnIH0pO1xuICAgICAgICAgICAgb3B0Q29udGFpbmVyLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7XG4gICAgICAgICAgICBvcHRDb250YWluZXIuc3R5bGUuZmxleFdyYXAgPSAnd3JhcCc7XG4gICAgICAgICAgICBvcHRDb250YWluZXIuc3R5bGUuZ2FwID0gJzEwcHgnO1xuICAgICAgICAgICAgb3B0Q29udGFpbmVyLnN0eWxlLmp1c3RpZnlDb250ZW50ID0gJ2NlbnRlcic7XG5cbiAgICAgICAgICAgIGZvciAoY29uc3Qgb3B0IG9mIHNlc3Npb24ub3B0aW9ucykge1xuICAgICAgICAgICAgICAgIGNvbnN0IGJ0biA9IG9wdENvbnRhaW5lci5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiBvcHQubGFiZWwgfSk7XG4gICAgICAgICAgICAgICAgYnRuLnN0eWxlLnBhZGRpbmcgPSAnMTBweCAxNXB4JztcbiAgICAgICAgICAgICAgICBidG4ub25jbGljayA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgbmV3IE5vdGljZShgU2VsZWN0ZWQ6ICR7b3B0LmxhYmVsfWApO1xuICAgICAgICAgICAgICAgICAgICAvLyBUT0RPOiBDb250aW51ZSBjb252ZXJzYXRpb24gd2l0aCBzZWxlY3RlZCBvcHRpb25cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gU2F2ZSBidXR0b25cbiAgICAgICAgY29uc3Qgc2F2ZUNvbnRhaW5lciA9IHRoaXMucmVzdWx0RWwuY3JlYXRlRGl2KCk7XG4gICAgICAgIHNhdmVDb250YWluZXIuc3R5bGUubWFyZ2luVG9wID0gJzIwcHgnO1xuICAgICAgICBzYXZlQ29udGFpbmVyLnN0eWxlLnRleHRBbGlnbiA9ICdjZW50ZXInO1xuXG4gICAgICAgIGNvbnN0IHNhdmVCdG4gPSBzYXZlQ29udGFpbmVyLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICAgICAgICB0ZXh0OiAn8J+SviBTYXZlIHRvIFZhdWx0JyxcbiAgICAgICAgICAgIGNsczogJ21vZC1jdGEnXG4gICAgICAgIH0pO1xuICAgICAgICBzYXZlQnRuLnN0eWxlLmZvbnRTaXplID0gJzEuMWVtJztcbiAgICAgICAgc2F2ZUJ0bi5zdHlsZS5wYWRkaW5nID0gJzEwcHggMjBweCc7XG4gICAgICAgIHNhdmVCdG4ub25jbGljayA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcGF0aCA9IGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXNzaW9uVG9WYXVsdChzZXNzaW9uKTtcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKGBTYXZlZCB0byAke3BhdGh9YCk7XG4gICAgICAgICAgICAgICAgdGhpcy5jbG9zZSgpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKCdGYWlsZWQgdG8gc2F2ZSBzZXNzaW9uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gUmVzZXQgcmVjb3JkIGJ1dHRvblxuICAgICAgICB0aGlzLnJlY29yZEJ0bi5zZXRUZXh0KCfij7ogUmVjb3JkIEFub3RoZXInKTtcbiAgICAgICAgdGhpcy5yZWNvcmRCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgdGhpcy5yZWNvcmRCdG4ucmVtb3ZlQ2xhc3MoJ21vZC13YXJuaW5nJyk7XG4gICAgICAgIHRoaXMucmVjb3JkQnRuLmFkZENsYXNzKCdtb2QtY3RhJyk7XG4gICAgfVxuXG4gICAgYmxvYlRvQmFzZTY0KGJsb2I6IEJsb2IpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcbiAgICAgICAgICAgIHJlYWRlci5vbmxvYWRlbmQgPSAoKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgYmFzZTY0ID0gKHJlYWRlci5yZXN1bHQgYXMgc3RyaW5nKS5zcGxpdCgnLCcpWzFdO1xuICAgICAgICAgICAgICAgIHJlc29sdmUoYmFzZTY0KTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICByZWFkZXIub25lcnJvciA9IHJlamVjdDtcbiAgICAgICAgICAgIHJlYWRlci5yZWFkQXNEYXRhVVJMKGJsb2IpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBvbkNsb3NlKCkge1xuICAgICAgICAvLyBTdG9wIHJlY29yZGluZyBpZiBzdGlsbCBhY3RpdmVcbiAgICAgICAgaWYgKHRoaXMuaXNSZWNvcmRpbmcgJiYgdGhpcy5tZWRpYVJlY29yZGVyKSB7XG4gICAgICAgICAgICB0aGlzLm1lZGlhUmVjb3JkZXIuc3RvcCgpO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLnRpbWVySW50ZXJ2YWwpIHtcbiAgICAgICAgICAgIHdpbmRvdy5jbGVhckludGVydmFsKHRoaXMudGltZXJJbnRlcnZhbCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgeyBjb250ZW50RWwgfSA9IHRoaXM7XG4gICAgICAgIGNvbnRlbnRFbC5lbXB0eSgpO1xuICAgIH1cbn1cblxuLy8gU2V0dGluZ3MgVGFiXG5jbGFzcyBCSkpGbGlwbW9kZVNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgICBwbHVnaW46IEJKSkZsaXBtb2RlUGx1Z2luO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogQkpKRmxpcG1vZGVQbHVnaW4pIHtcbiAgICAgICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgICAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICB9XG5cbiAgICBkaXNwbGF5KCk6IHZvaWQge1xuICAgICAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgICAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuXG4gICAgICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0ZsaXBtb2RlIFNldHRpbmdzJyB9KTtcblxuICAgICAgICAvLyBTZXJ2ZXIgVVJMXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1NlcnZlciBVUkwnKVxuICAgICAgICAgICAgLnNldERlc2MoJ1VSTCBvZiB5b3VyIEZsaXBtb2RlIHNlcnZlcicpXG4gICAgICAgICAgICAuYWRkVGV4dCh0ZXh0ID0+IHRleHRcbiAgICAgICAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ2h0dHA6Ly9sb2NhbGhvc3Q6NTAwNScpXG4gICAgICAgICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnNlcnZlclVybClcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnNlcnZlclVybCA9IHZhbHVlO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICB9KSk7XG5cbiAgICAgICAgLy8gQVBJIFRva2VuXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ0FQSSBUb2tlbicpXG4gICAgICAgICAgICAuc2V0RGVzYygnWW91ciBBUEkgdG9rZW4gZnJvbSB0aGUgRmxpcG1vZGUgcHJvZmlsZSBwYWdlJylcbiAgICAgICAgICAgIC5hZGRUZXh0KHRleHQgPT4gdGV4dFxuICAgICAgICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignRW50ZXIgeW91ciBBUEkgdG9rZW4nKVxuICAgICAgICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5hcGlUb2tlbilcbiAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmFwaVRva2VuID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBTeW5jIEZvbGRlclxuICAgICAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgICAgICAgIC5zZXROYW1lKCdTeW5jIEZvbGRlcicpXG4gICAgICAgICAgICAuc2V0RGVzYygnRm9sZGVyIGluIHlvdXIgdmF1bHQgZm9yIEZsaXBtb2RlIGNvbnRlbnQnKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PiB0ZXh0XG4gICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCdGbGlwbW9kZScpXG4gICAgICAgICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnN5bmNGb2xkZXIpXG4gICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zeW5jRm9sZGVyID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBBdXRvIFN5bmNcbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnQXV0byBTeW5jJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdBdXRvbWF0aWNhbGx5IHN5bmMgd2l0aCBGbGlwbW9kZSBwZXJpb2RpY2FsbHknKVxuICAgICAgICAgICAgLmFkZFRvZ2dsZSh0b2dnbGUgPT4gdG9nZ2xlXG4gICAgICAgICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmF1dG9TeW5jKVxuICAgICAgICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuYXV0b1N5bmMgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc3RhcnRBdXRvU3luYygpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgICAgIC8vIFN5bmMgSW50ZXJ2YWxcbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnU3luYyBJbnRlcnZhbCcpXG4gICAgICAgICAgICAuc2V0RGVzYygnTWludXRlcyBiZXR3ZWVuIGF1dG9tYXRpYyBzeW5jcycpXG4gICAgICAgICAgICAuYWRkU2xpZGVyKHNsaWRlciA9PiBzbGlkZXJcbiAgICAgICAgICAgICAgICAuc2V0TGltaXRzKDUsIDEyMCwgNSlcbiAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3Muc3luY0ludGVydmFsKVxuICAgICAgICAgICAgICAgIC5zZXREeW5hbWljVG9vbHRpcCgpXG4gICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zeW5jSW50ZXJ2YWwgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgfSkpO1xuXG4gICAgICAgIC8vIFRlc3QgQ29ubmVjdGlvbiBidXR0b25cbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnVGVzdCBDb25uZWN0aW9uJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdWZXJpZnkgY29ubmVjdGlvbiB0byBGbGlwbW9kZSBzZXJ2ZXInKVxuICAgICAgICAgICAgLmFkZEJ1dHRvbihidG4gPT4gYnRuXG4gICAgICAgICAgICAgICAgLnNldEJ1dHRvblRleHQoJ1Rlc3QnKVxuICAgICAgICAgICAgICAgIC5vbkNsaWNrKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgdGhpcy5wbHVnaW4uY2hlY2tDb25uZWN0aW9uKCk7XG4gICAgICAgICAgICAgICAgICAgIG5ldyBOb3RpY2UoY29ubmVjdGVkXG4gICAgICAgICAgICAgICAgICAgICAgICA/ICdTdWNjZXNzZnVsbHkgY29ubmVjdGVkIHRvIEZsaXBtb2RlISdcbiAgICAgICAgICAgICAgICAgICAgICAgIDogJ0NvdWxkIG5vdCBjb25uZWN0IHRvIEZsaXBtb2RlJyk7XG4gICAgICAgICAgICAgICAgfSkpO1xuICAgIH1cbn1cbiJdfQ==