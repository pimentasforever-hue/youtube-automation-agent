const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const { sanitizeText, sanitizeObject } = require('../utils/text-sanitizer');

// Cinematic vocabulary, modelled on the ViMax storyboard artist (https://github.com/hkuds/vimax).
// Every shot is built from a size, an angle and a movement so the prompts carry real
// cinematic language instead of the generic "ethereal dreamscape" strings used before.
const SHOT_SIZES = [
  'extreme wide shot',
  'wide shot',
  'medium wide shot',
  'medium shot',
  'medium close-up',
  'close-up',
  'extreme close-up',
  'over-the-shoulder shot'
];

const CAMERA_ANGLES = ['eye level', 'low angle', 'high angle', 'slight dutch angle', 'aerial view'];

// `retiresCamera` follows the ViMax rule: once a camera performs a significant move it
// cannot be reused for a later shot, because its framing no longer matches.
const CAMERA_MOVEMENTS = [
  { name: 'static', variation: 'small', retiresCamera: false },
  { name: 'slow pan right', variation: 'small', retiresCamera: false },
  { name: 'slow pan left', variation: 'small', retiresCamera: false },
  { name: 'slow tilt up', variation: 'small', retiresCamera: false },
  { name: 'handheld drift', variation: 'small', retiresCamera: false },
  { name: 'slow dolly in', variation: 'medium', retiresCamera: true },
  { name: 'slow dolly out', variation: 'medium', retiresCamera: true },
  { name: 'tracking shot', variation: 'medium', retiresCamera: true },
  { name: 'crane up', variation: 'large', retiresCamera: true },
  { name: 'drone fly-over', variation: 'large', retiresCamera: true }
];

const STYLE_PRESETS = {
  cinematic: {
    name: 'cinematic',
    look: 'cinematic film still, anamorphic lens, shallow depth of field, volumetric light',
    palette: 'teal shadows, warm amber highlights',
    lighting: 'soft key light with strong rim separation',
    grade: 'filmic contrast, subtle grain'
  },
  documentary: {
    name: 'documentary',
    look: 'documentary photography, natural lens, honest framing',
    palette: 'neutral earth tones with muted blues',
    lighting: 'available light, soft window key',
    grade: 'low contrast, true-to-life color'
  },
  tutorial: {
    name: 'tutorial',
    look: 'clean studio product photography, uncluttered background',
    palette: 'white, deep blue and a single accent color',
    lighting: 'bright even softbox lighting',
    grade: 'high clarity, crisp edges'
  },
  story: {
    name: 'story',
    look: 'narrative cinema still, character driven framing',
    palette: 'deep blues and gold highlights',
    lighting: 'motivated practical lights, strong shadows',
    grade: 'rich contrast, cinematic color'
  },
  explainer: {
    name: 'explainer',
    look: 'modern editorial illustration blended with photography',
    palette: 'violet, cyan and off-white',
    lighting: 'even diffused light with soft gradients',
    grade: 'clean and legible'
  }
};

// The beat plan drives the template fallback: each narrative beat gets its own
// shot grammar so a storyboard still reads like a storyboard without any AI provider.
const BEAT_PLANS = {
  hook: {
    purpose: 'grab attention in the first seconds',
    sizes: ['extreme close-up', 'medium close-up', 'wide shot'],
    angles: ['low angle', 'eye level'],
    movements: ['slow dolly in', 'handheld drift', 'static']
  },
  intro: {
    purpose: 'establish the subject and the setting',
    sizes: ['extreme wide shot', 'wide shot', 'medium shot'],
    angles: ['aerial view', 'eye level', 'high angle'],
    movements: ['drone fly-over', 'slow pan right', 'static']
  },
  body: {
    purpose: 'carry the argument with visual variety',
    sizes: ['medium shot', 'close-up', 'medium wide shot', 'over-the-shoulder shot'],
    angles: ['eye level', 'high angle', 'low angle'],
    movements: ['static', 'slow pan left', 'tracking shot', 'slow dolly out']
  },
  conclusion: {
    purpose: 'land the payoff and resolve the tension',
    sizes: ['medium close-up', 'wide shot'],
    angles: ['eye level', 'slight dutch angle'],
    movements: ['slow dolly out', 'crane up']
  },
  cta: {
    purpose: 'drive the viewer action',
    sizes: ['medium shot', 'close-up'],
    angles: ['eye level'],
    movements: ['static', 'slow dolly in']
  }
};

const DEFAULT_SECONDS_PER_SHOT = 8;
const MIN_SHOT_SECONDS = 3;
const MAX_SHOT_SECONDS = 15;
const NEGATIVE_PROMPT = 'text artifacts, watermark, distorted faces, extra limbs, low resolution, blurry, oversaturated';

class StoryboardDirectorAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('StoryboardDirector');
    this.aiTextService = new AITextService(credentials);
  }

  async initialize() {
    this.logger.info('Initializing Storyboard Director Agent...');
    return true;
  }

  /**
   * Turns a script into a shot-by-shot storyboard: visual bible, scenes, shots with
   * first frame / last frame / motion decomposition, camera continuity and render prompts.
   */
  async generateStoryboard(script, options = {}) {
    try {
      this.logger.info(`Designing storyboard for: ${script.title}`);

      const style = this.resolveStyle(script, options);
      const scenes = this.extractScenes(script, options);
      const totalSeconds = this.parseDurationSeconds(script.duration, scenes);
      const shotBudget = this.calculateShotBudget(totalSeconds, scenes.length, options);

      const bible = await this.buildVisualBible(script, scenes, style);
      const { shots, source } = await this.designShots(scenes, bible, style, shotBudget);

      const cameras = this.assignCameras(shots);
      this.distributeDurations(shots, scenes, totalSeconds);
      shots.forEach(shot => this.buildShotPrompts(shot, bible, style));

      const continuity = this.validateContinuity(shots, bible, cameras);

      const storyboard = sanitizeObject({
        title: script.title,
        scriptId: script.id || null,
        style,
        scenes,
        visualBible: bible,
        shots,
        cameras,
        continuity,
        totalDuration: totalSeconds,
        metadata: {
          shotCount: shots.length,
          sceneCount: scenes.length,
          cameraCount: cameras.length,
          generationSource: source,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      });

      await this.persist(storyboard);

      this.logger.info(`Storyboard ready: ${shots.length} shots across ${scenes.length} scenes (${cameras.length} cameras, source: ${source})`);
      return storyboard;
    } catch (error) {
      this.logger.error('Failed to generate storyboard:', error);
      throw error;
    }
  }

  async persist(storyboard) {
    if (typeof this.db?.saveStoryboard !== 'function') {
      return null;
    }

    try {
      return await this.db.saveStoryboard(storyboard);
    } catch (error) {
      this.logger.warn(`Storyboard not persisted: ${error.message}`);
      return null;
    }
  }

  resolveStyle(script, options = {}) {
    const requested = String(options.style || script.metadata?.strategy?.contentType || '').toLowerCase();
    const preset = STYLE_PRESETS[requested]
      || STYLE_PRESETS[requested.replace(/\s+/g, '')]
      || (requested.includes('tutorial') ? STYLE_PRESETS.tutorial : null)
      || (requested.includes('story') ? STYLE_PRESETS.story : null)
      || STYLE_PRESETS.cinematic;

    return {
      ...preset,
      aspectRatio: options.aspectRatio || '16:9',
      tone: script.tone || 'engaging',
      pacing: script.pacing || 'medium'
    };
  }

  /**
   * Stage 1 , scene extraction. The script sections already carry the narrative beats,
   * so each beat becomes a scene with its own environment slugline and narration.
   */
  extractScenes(script, options = {}) {
    const scenes = [];
    const push = (beat, title, lines, seconds) => {
      const narration = (Array.isArray(lines) ? lines : [lines])
        .filter(Boolean)
        .map(line => sanitizeText(String(line)).trim())
        .filter(Boolean);

      if (narration.length === 0) {
        return;
      }

      scenes.push({
        idx: scenes.length,
        beat,
        title: sanitizeText(String(title || beat)).slice(0, 120),
        slugline: this.buildSlugline(beat, title),
        narration,
        durationSeconds: Math.max(MIN_SHOT_SECONDS, Math.round(seconds || 30)),
        isLast: false
      });
    };

    push('hook', 'Hook', script.hook?.text || script.hook, 8);
    push('intro', 'Introduction', this.collectText(script.introduction), 20);

    const sections = Array.isArray(script.mainContent?.sections) ? script.mainContent.sections : [];
    sections.forEach((section) => {
      push('body', section.title, this.collectText(section), section.duration || 60);
    });

    push('conclusion', 'Conclusion', this.collectText(script.conclusion), 25);

    if (options.includeCTA !== false) {
      push('cta', 'Call To Action', this.collectText(script.callToAction), 15);
    }

    if (scenes.length === 0) {
      push('body', script.title || 'Main Scene', script.fullScript || script.title || 'Main scene', 60);
    }

    scenes[scenes.length - 1].isLast = true;
    return scenes;
  }

  collectText(node) {
    if (!node) return [];
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap(item => this.collectText(item));

    const skipKeys = new Set(['type', 'duration', 'title']);
    return Object.entries(node)
      .filter(([key, value]) => !skipKeys.has(key) && (typeof value === 'string' || Array.isArray(value) || (value && typeof value === 'object')))
      .flatMap(([, value]) => this.collectText(value));
  }

  buildSlugline(beat, title) {
    const place = beat === 'intro' || beat === 'hook' ? 'EXT. ESTABLISHING SPACE' : 'INT. FEATURE SPACE';
    const label = String(title || beat).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 40);
    return `${place} , ${label || beat.toUpperCase()} , DAY`;
  }

  parseDurationSeconds(duration, scenes = []) {
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      return Math.round(duration);
    }

    const match = String(duration || '').match(/^(\d+):(\d{1,2})$/);
    if (match) {
      return (parseInt(match[1], 10) * 60) + parseInt(match[2], 10);
    }

    const fallback = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    return fallback || 480;
  }

  calculateShotBudget(totalSeconds, sceneCount, options = {}) {
    const secondsPerShot = Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, Number(options.secondsPerShot) || DEFAULT_SECONDS_PER_SHOT));
    const requested = Number(options.shotCount) || Number(options.sceneCount);
    const derived = Math.ceil(totalSeconds / secondsPerShot);
    const total = Math.min(180, Math.max(sceneCount, requested || derived));

    return { total, secondsPerShot, perScene: Math.max(1, Math.round(total / Math.max(1, sceneCount))) };
  }

  /**
   * Stage 2 , the visual bible. ViMax keeps character static/dynamic features separate so
   * the same subject can be re-rendered consistently across shots; the same idea applies to
   * the recurring subjects and environments of a YouTube script.
   */
  async buildVisualBible(script, scenes, style) {
    const aiBible = await this.buildVisualBibleWithAI(script, scenes, style);
    if (aiBible) {
      return aiBible;
    }

    return this.buildVisualBibleFromTemplate(script, scenes, style);
  }

  async buildVisualBibleWithAI(script, scenes, style) {
    if (!this.aiTextService.isAvailable()) {
      return null;
    }

    const prompt = `You are a film production designer building a visual bible for a video.
Return ONLY JSON with this shape:
{
  "subjects": [{"identifier": "string", "staticFeatures": "physical traits that never change", "dynamicFeatures": "clothing, props, accessories"}],
  "environments": [{"slugline": "string", "description": "concrete visual description"}],
  "motifs": ["recurring visual motif"]
}

Rules:
- 2 to 4 subjects. A subject can be a person, an object or a data visualization, but it must be a single concrete thing.
- Describe only what a camera can see: colors, materials, shapes, scale. No personality, no roles.
- Make subjects visually distinct from each other.
- 2 to 4 environments, one per major beat.

Video title: ${script.title}
Style: ${style.name}, ${style.look}
Palette: ${style.palette}
Beats:
${scenes.map(scene => `- ${scene.beat}: ${scene.title} , ${scene.narration.join(' ').slice(0, 200)}`).join('\n')}`;

    try {
      const response = await this.aiTextService.generateText(prompt, { maxTokens: 1200, temperature: 0.6 });
      const parsed = this.parseAIJsonResponse(response);
      const subjects = this.normalizeSubjects(parsed.subjects);

      if (subjects.length === 0) {
        throw new Error('Visual bible response has no usable subjects');
      }

      return {
        subjects,
        environments: this.normalizeEnvironments(parsed.environments, scenes),
        motifs: (Array.isArray(parsed.motifs) ? parsed.motifs : []).map(motif => sanitizeText(String(motif))).filter(Boolean).slice(0, 6),
        source: 'ai'
      };
    } catch (error) {
      this.logger.warn(`AI visual bible failed; using template fallback: ${error.message}`);
      return null;
    }
  }

  buildVisualBibleFromTemplate(script, scenes, style) {
    const topic = script.metadata?.strategy?.topic || script.title || 'the subject';
    const keywords = (script.keywords || []).slice(0, 3);

    const subjects = [
      {
        idx: 0,
        identifier: 'Presenter',
        staticFeatures: 'adult presenter, medium build, short dark hair, expressive eyes',
        dynamicFeatures: 'dark tailored jacket over a plain shirt, no visible logos'
      },
      {
        idx: 1,
        identifier: `${topic} artifact`,
        staticFeatures: `a physical stand-in for ${topic}, matte surface, clean geometry`,
        dynamicFeatures: 'sitting on a textured surface with a single accent light'
      },
      {
        idx: 2,
        identifier: 'Data panel',
        staticFeatures: 'floating translucent panel with simple charts and short labels',
        dynamicFeatures: keywords.length ? `labels reading ${keywords.join(', ')}` : 'labels reading key metrics'
      }
    ];

    return {
      subjects,
      environments: this.normalizeEnvironments(null, scenes),
      motifs: [`${style.palette} color accents`, 'shallow depth of field', 'clean negative space'],
      source: 'template'
    };
  }

  normalizeSubjects(subjects) {
    if (!Array.isArray(subjects)) return [];

    return subjects
      .slice(0, 6)
      .map((subject, idx) => ({
        idx,
        identifier: sanitizeText(String(subject?.identifier || `Subject ${idx + 1}`)).slice(0, 60),
        staticFeatures: sanitizeText(String(subject?.staticFeatures || '')).slice(0, 300),
        dynamicFeatures: sanitizeText(String(subject?.dynamicFeatures || '')).slice(0, 300)
      }))
      .filter(subject => subject.identifier && subject.staticFeatures);
  }

  normalizeEnvironments(environments, scenes) {
    if (Array.isArray(environments) && environments.length > 0) {
      return environments
        .slice(0, 8)
        .map((environment, idx) => ({
          idx,
          slugline: sanitizeText(String(environment?.slugline || scenes[idx]?.slugline || `ENV ${idx + 1}`)).slice(0, 120),
          description: sanitizeText(String(environment?.description || '')).slice(0, 400)
        }))
        .filter(environment => environment.description);
    }

    const beatSpaces = {
      hook: 'An open space with a single strong light source and deep negative space',
      intro: 'A wide space with clear foreground, midground and background layers',
      body: 'A working space with the subject centred and props within reach',
      conclusion: 'A quiet space with the light softening and the background falling away',
      cta: 'A tidy space facing the camera, uncluttered and ready for a direct address'
    };

    return scenes.map((scene, idx) => ({
      idx,
      slugline: scene.slugline,
      description: `${beatSpaces[scene.beat] || beatSpaces.body}, dressed for "${scene.title}"`
    }));
  }

  /**
   * Stage 3 , shot design. One AI call covers the whole board so the model can keep
   * continuity between scenes; the template path produces the same structure offline.
   */
  async designShots(scenes, bible, style, shotBudget) {
    const aiShots = await this.designShotsWithAI(scenes, bible, style, shotBudget);
    if (aiShots && aiShots.length > 0) {
      return { shots: aiShots, source: 'ai' };
    }

    const shots = scenes.flatMap(scene => this.designSceneShotsFromTemplate(scene, bible, style, shotBudget));
    shots.forEach((shot, idx) => {
      shot.idx = idx;
      shot.isLast = idx === shots.length - 1;
    });

    return { shots, source: 'template' };
  }

  async designShotsWithAI(scenes, bible, style, shotBudget) {
    if (!this.aiTextService.isAvailable()) {
      return null;
    }

    const prompt = `You are a professional storyboard artist. Design a shot list for a narrated video.
Return ONLY JSON with this shape:
{
  "shots": [{
    "sceneIdx": 0,
    "purpose": "why this shot exists",
    "shotSize": "one of: ${SHOT_SIZES.join(' | ')}",
    "angle": "one of: ${CAMERA_ANGLES.join(' | ')}",
    "movement": "one of: ${CAMERA_MOVEMENTS.map(movement => movement.name).join(' | ')}",
    "subjects": ["identifier from the subject list"],
    "firstFrame": "static snapshot at the start of the shot",
    "lastFrame": "static snapshot at the end of the shot",
    "motion": "what moves between the two frames, camera move and subject move",
    "variationType": "small | medium | large"
  }]
}

Rules:
- Produce about ${shotBudget.total} shots in total, roughly ${shotBudget.perScene} per scene, and cover every scene index from 0 to ${scenes.length - 1}.
- The first shot of the board must be the widest shot, establishing the whole space.
- First frame and last frame are pure snapshots: no "about to", no ongoing action.
- The motion field must describe camera movement and subject movement separately, using film terms.
- In frame descriptions, state where each element sits in the frame and which way it faces.
- Reuse camera setups: only change size and angle when the story needs it.
- variationType is large for transitions that change the framing completely, medium when a new subject enters, small for minor changes.
- Keep subject names identical to the subject list.
- Avoid unsafe imagery; suggest tension with light, sound or framing instead.

Style: ${style.name}, ${style.look}, ${style.lighting}, palette ${style.palette}
Subjects:
${bible.subjects.map(subject => `- ${subject.identifier}: ${subject.staticFeatures}; ${subject.dynamicFeatures}`).join('\n')}
Scenes:
${scenes.map(scene => `#${scene.idx} [${scene.beat}] ${scene.title} (${scene.durationSeconds}s) , ${scene.narration.join(' ').slice(0, 320)}`).join('\n')}`;

    try {
      const response = await this.aiTextService.generateText(prompt, { maxTokens: 4096, temperature: 0.7 });
      const parsed = this.parseAIJsonResponse(response);
      const shots = this.normalizeAIShots(parsed.shots, scenes, bible);

      if (shots.length === 0) {
        throw new Error('Shot list response has no usable shots');
      }

      const coveredScenes = new Set(shots.map(shot => shot.sceneIdx));
      const missing = scenes.filter(scene => !coveredScenes.has(scene.idx));
      if (missing.length > 0) {
        this.logger.warn(`AI shot list skipped ${missing.length} scene(s); filling them from templates`);
        missing.forEach((scene) => {
          shots.push(...this.designSceneShotsFromTemplate(scene, bible, style, shotBudget));
        });
      }

      shots.sort((left, right) => left.sceneIdx - right.sceneIdx);
      shots.forEach((shot, idx) => {
        shot.idx = idx;
        shot.isLast = idx === shots.length - 1;
      });

      this.logger.info(`Shot list designed with ${this.aiTextService.providerName}`);
      return shots;
    } catch (error) {
      this.logger.warn(`AI shot design failed; using template fallback: ${error.message}`);
      return null;
    }
  }

  normalizeAIShots(shots, scenes, bible) {
    if (!Array.isArray(shots)) return [];

    const subjectNames = bible.subjects.map(subject => subject.identifier);

    return shots
      .slice(0, 180)
      .map((shot) => {
        const sceneIdx = Number.isInteger(shot?.sceneIdx) ? shot.sceneIdx : parseInt(shot?.sceneIdx, 10);
        const scene = scenes[sceneIdx];
        if (!scene) return null;

        const firstFrame = sanitizeText(String(shot?.firstFrame || '')).trim();
        const motion = sanitizeText(String(shot?.motion || '')).trim();
        if (!firstFrame || !motion) return null;

        const movement = this.matchMovement(shot?.movement);
        const normalized = {
          sceneIdx,
          beat: scene.beat,
          sceneTitle: scene.title,
          purpose: sanitizeText(String(shot?.purpose || BEAT_PLANS[scene.beat]?.purpose || 'advance the narrative')).slice(0, 200),
          shotSize: this.matchFromList(shot?.shotSize, SHOT_SIZES, 'medium shot'),
          angle: this.matchFromList(shot?.angle, CAMERA_ANGLES, 'eye level'),
          movement: movement.name,
          subjects: (Array.isArray(shot?.subjects) ? shot.subjects : [])
            .map(subject => sanitizeText(String(subject)).trim())
            .filter(Boolean)
            .slice(0, 4),
          firstFrame: firstFrame.slice(0, 700),
          lastFrame: (sanitizeText(String(shot?.lastFrame || firstFrame)).trim() || firstFrame).slice(0, 700),
          motion: motion.slice(0, 700),
          narration: scene.narration.join(' ').slice(0, 400),
          source: 'ai'
        };

        normalized.unknownSubjects = normalized.subjects.filter(subject => !subjectNames.includes(subject));
        normalized.variationType = this.classifyVariation(shot?.variationType, normalized, movement);
        return normalized;
      })
      .filter(Boolean);
  }

  designSceneShotsFromTemplate(scene, bible, style, shotBudget) {
    const plan = BEAT_PLANS[scene.beat] || BEAT_PLANS.body;
    const count = Math.max(1, Math.min(12, Math.round(scene.durationSeconds / shotBudget.secondsPerShot) || shotBudget.perScene));
    const environment = bible.environments[scene.idx % bible.environments.length];
    const narrationLines = scene.narration;

    // A scene is covered from a small pool of setups that the shots cycle through, so a
    // camera gets reused instead of a new one being invented for every shot.
    const setupCount = Math.max(1, Math.min(3, Math.ceil(count / 2)));
    const usedSetups = new Set();

    return Array.from({ length: count }, (_, position) => {
      const setupIdx = position % setupCount;
      const shotSize = plan.sizes[setupIdx % plan.sizes.length];
      const angle = plan.angles[setupIdx % plan.angles.length];
      // Once a setup has been filmed, later shots on it keep a movement that does not
      // retire the camera, otherwise the framing would no longer match.
      const reuse = usedSetups.has(setupIdx);
      usedSetups.add(setupIdx);
      const candidate = this.matchMovement(plan.movements[position % plan.movements.length]);
      const movement = reuse && candidate.retiresCamera
        ? this.matchMovement(position % 2 === 0 ? 'static' : 'slow pan right')
        : candidate;
      const subject = bible.subjects[(scene.idx + setupIdx) % bible.subjects.length];
      const secondary = bible.subjects[(scene.idx + setupIdx + 1) % bible.subjects.length];
      const beatLine = narrationLines[position % narrationLines.length];
      // ViMax opens every board on the widest possible framing so the viewer reads the space first.
      const isEstablishing = scene.idx === 0 && position === 0;
      const effectiveSize = isEstablishing ? 'extreme wide shot' : shotSize;
      const effectiveAngle = isEstablishing ? 'aerial view' : angle;

      const shot = {
        sceneIdx: scene.idx,
        beat: scene.beat,
        sceneTitle: scene.title,
        purpose: isEstablishing ? 'establish the whole space before anything else' : plan.purpose,
        shotSize: effectiveSize,
        angle: effectiveAngle,
        movement: movement.name,
        subjects: [subject.identifier],
        firstFrame: `${this.capitalize(effectiveSize)} at ${effectiveAngle}. ${environment.description}. ${subject.identifier} (${subject.staticFeatures}, ${subject.dynamicFeatures}) sits ${position % 2 === 0 ? 'left of center, facing right' : 'right of center, facing left'}, in sharp focus. ${style.lighting}, ${style.palette}.`,
        lastFrame: `${this.capitalize(effectiveSize)} at ${effectiveAngle}. Same space, ${subject.identifier} now ${position % 2 === 0 ? 'closer to the center of the frame, facing camera' : 'settled at the edge of the frame, facing center'}. ${movement.variation === 'small' ? 'Framing is nearly unchanged.' : `${secondary.identifier} is now visible in the background.`} ${style.lighting}.`,
        motion: `Camera: ${movement.name}. In frame: ${subject.identifier} shifts weight and turns slightly toward camera while the light rakes across the surface. Narration: "${String(beatLine).slice(0, 180)}"`,
        narration: String(beatLine).slice(0, 400),
        source: 'template'
      };

      shot.unknownSubjects = [];
      shot.variationType = this.classifyVariation(movement.variation, shot, movement);
      return shot;
    });
  }

  matchFromList(value, list, fallback) {
    const normalized = sanitizeText(String(value || '')).toLowerCase().trim();
    return list.find(item => item === normalized)
      || list.find(item => normalized.includes(item) || item.includes(normalized))
      || fallback;
  }

  matchMovement(value) {
    const name = this.matchFromList(value, CAMERA_MOVEMENTS.map(movement => movement.name), 'static');
    return CAMERA_MOVEMENTS.find(movement => movement.name === name) || CAMERA_MOVEMENTS[0];
  }

  classifyVariation(declared, shot, movement) {
    const normalized = String(declared || '').toLowerCase().trim();
    if (['small', 'medium', 'large'].includes(normalized)) {
      return normalized;
    }

    if (movement.variation === 'large') return 'large';
    if (shot.subjects.length > 1) return 'medium';
    return movement.variation;
  }

  /**
   * Stage 4 , camera continuity. Shots that share a scene, a size, an angle and a subject
   * are filmed from the same camera. A camera that performed a significant move is retired,
   * exactly like the ViMax storyboard rule.
   */
  assignCameras(shots) {
    const cameras = [];
    const activeByKey = new Map();

    shots.forEach((shot) => {
      const movement = this.matchMovement(shot.movement);
      const key = `${shot.sceneIdx}|${shot.shotSize}|${shot.angle}|${shot.subjects[0] || 'none'}`;
      const existing = activeByKey.get(key);

      let camera;
      if (existing && !existing.retired) {
        camera = existing;
      } else {
        camera = {
          idx: cameras.length,
          sceneIdx: shot.sceneIdx,
          shotSize: shot.shotSize,
          angle: shot.angle,
          subject: shot.subjects[0] || null,
          activeShotIdxs: [],
          retired: false,
          retiredReason: null
        };
        cameras.push(camera);
        activeByKey.set(key, camera);
      }

      camera.activeShotIdxs.push(shot.idx);
      shot.camIdx = camera.idx;
      shot.reusedCamera = camera.activeShotIdxs.length > 1;

      if (movement.retiresCamera) {
        camera.retired = true;
        camera.retiredReason = `camera performed a ${movement.name} and no longer matches its original framing`;
      }
    });

    return cameras;
  }

  /**
   * Stage 5 , timing. Each scene keeps its narration budget and splits it across its shots,
   * so the shot list stays in sync with the narration the production agent will render.
   */
  distributeDurations(shots, scenes, totalSeconds) {
    const sceneBudget = scenes.reduce((total, scene) => total + scene.durationSeconds, 0) || totalSeconds;
    const scale = totalSeconds / sceneBudget;

    scenes.forEach((scene) => {
      const sceneShots = shots.filter(shot => shot.sceneIdx === scene.idx);
      if (sceneShots.length === 0) return;

      const sceneSeconds = Math.max(MIN_SHOT_SECONDS, Math.round(scene.durationSeconds * scale));
      const perShot = sceneSeconds / sceneShots.length;

      let assigned = 0;
      sceneShots.forEach((shot, position) => {
        const isLastOfScene = position === sceneShots.length - 1;
        const seconds = isLastOfScene
          ? Math.max(MIN_SHOT_SECONDS, sceneSeconds - assigned)
          : Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.round(perShot)));

        shot.durationSeconds = seconds;
        shot.startsAt = assigned;
        assigned += seconds;
      });

      scene.plannedSeconds = assigned;
    });

    let elapsed = 0;
    shots.forEach((shot) => {
      shot.timelineStart = elapsed;
      elapsed += shot.durationSeconds;
    });

    return elapsed;
  }

  /**
   * Stage 6 , render prompts. The first frame drives the image prompt, the motion
   * description drives the video prompt, and the subject features keep both consistent.
   */
  buildShotPrompts(shot, bible, style) {
    const subjectFeatures = shot.subjects
      .map(name => bible.subjects.find(subject => subject.identifier === name))
      .filter(Boolean)
      .map(subject => `${subject.identifier}: ${subject.staticFeatures}, ${subject.dynamicFeatures}`)
      .join('. ');

    const styleTail = `${style.look}, ${style.lighting}, ${style.palette}, ${style.grade}, ${style.aspectRatio} aspect ratio`;

    shot.imagePrompt = sanitizeText(`${shot.firstFrame} ${subjectFeatures ? `Consistency: ${subjectFeatures}.` : ''} ${styleTail}`).slice(0, 1200);
    shot.lastFramePrompt = sanitizeText(`${shot.lastFrame} ${styleTail}`).slice(0, 1200);
    shot.videoPrompt = sanitizeText(`${shot.motion} Shot: ${shot.shotSize}, ${shot.angle}, ${shot.movement}. ${styleTail}`).slice(0, 1200);
    shot.stockQuery = sanitizeText(`${shot.sceneTitle} ${shot.shotSize} ${shot.movement}`).slice(0, 120);
    shot.negativePrompt = NEGATIVE_PROMPT;

    return shot;
  }

  /**
   * Stage 7 , continuity review. Reports the problems a human storyboard supervisor
   * would flag: unknown subjects, monotonous framing, shots that run too long.
   */
  validateContinuity(shots, bible, cameras) {
    const warnings = [];
    const subjectNames = bible.subjects.map(subject => subject.identifier);

    const unknown = new Set(shots.flatMap(shot => shot.unknownSubjects || []));
    if (unknown.size > 0) {
      warnings.push(`Shots reference subjects that are not in the visual bible: ${Array.from(unknown).join(', ')}`);
    }

    const firstShot = shots[0];
    if (firstShot && !['extreme wide shot', 'wide shot', 'aerial view'].includes(firstShot.shotSize) && firstShot.angle !== 'aerial view') {
      warnings.push('The opening shot is not an establishing shot, the viewer never sees the whole space');
    }

    shots.forEach((shot, idx) => {
      const previous = shots[idx - 1];
      if (previous && previous.shotSize === shot.shotSize && previous.angle === shot.angle && previous.sceneIdx === shot.sceneIdx && !shot.reusedCamera) {
        warnings.push(`Shot ${idx + 1} repeats the framing of shot ${idx} without reusing its camera`);
      }
      if (shot.durationSeconds > MAX_SHOT_SECONDS) {
        warnings.push(`Shot ${idx + 1} runs ${shot.durationSeconds}s, longer than the ${MAX_SHOT_SECONDS}s ceiling`);
      }
    });

    const reused = shots.filter(shot => shot.reusedCamera).length;

    return {
      warnings,
      shotCount: shots.length,
      cameraCount: cameras.length,
      reusedShotCount: reused,
      cameraReuseRatio: shots.length ? Number((reused / shots.length).toFixed(2)) : 0,
      subjectCount: subjectNames.length,
      passed: warnings.length === 0
    };
  }

  parseAIJsonResponse(response) {
    const text = String(response || '').trim();
    const withoutFences = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      return JSON.parse(withoutFences);
    } catch (error) {
      const match = withoutFences.match(/\{[\s\S]*\}/);
      if (!match) {
        throw error;
      }
      return JSON.parse(match[0]);
    }
  }

  capitalize(value) {
    const text = String(value || '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
}

/**
 * Flattens a storyboard into the prompt list the production agent renders.
 * When more scenes are requested than the board has shots, the shots cycle while keeping
 * their own framing so every generated scene still differs from the previous one.
 */
function buildStoryboardPrompts(storyboard, sceneCount) {
  const shots = Array.isArray(storyboard?.shots) ? storyboard.shots : [];
  if (shots.length === 0) {
    return [];
  }

  const total = Math.max(1, Number(sceneCount) || shots.length);

  return Array.from({ length: total }, (_, index) => {
    const shot = shots[index % shots.length];
    const pass = Math.floor(index / shots.length);
    const variantSuffix = pass > 0 ? `, alternate coverage ${pass + 1} of the same setup` : '';

    return {
      index,
      shotIdx: shot.idx,
      camIdx: shot.camIdx,
      sceneIdx: shot.sceneIdx,
      beat: shot.beat,
      prompt: `${shot.imagePrompt}${variantSuffix}`,
      videoPrompt: `${shot.videoPrompt}${variantSuffix}`,
      negativePrompt: shot.negativePrompt || NEGATIVE_PROMPT,
      stockQuery: shot.stockQuery,
      durationSeconds: shot.durationSeconds,
      variationType: shot.variationType
    };
  });
}

module.exports = {
  StoryboardDirectorAgent,
  buildStoryboardPrompts,
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  STYLE_PRESETS
};
