/*
 * Copyright (C) 2017 Ben Smith
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the LICENSE file for details.
 */
"use strict";

const RESULT_OK = 0;
const RESULT_ERROR = 1;
const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;
const AUDIO_FRAMES = 4096;
const AUDIO_LATENCY_SEC = 0.1;
const MAX_UPDATE_SEC = 5 / 60;
const CPU_TICKS_PER_SECOND = 4194304;
const EVENT_NEW_FRAME = 1;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;
const REWIND_FRAMES_PER_BASE_STATE = 45;
const REWIND_BUFFER_CAPACITY = 4 * 1024 * 1024;
const REWIND_FACTOR = 1.5;
const REWIND_UPDATE_MS = 16;

const $ = document.querySelector.bind(document);
let emulator = null;

const dbPromise = idb.open('db', 1, upgradeDb => {
  const objectStore = upgradeDb.createObjectStore('games', {keyPath : 'sha1'});
  objectStore.createIndex('sha1', 'sha1', {unique : true});
});

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = event => reject(event.error);
    reader.onloadend = event => resolve(event.target.result);
    reader.readAsArrayBuffer(file);
  });
}

let data = {
  fps: 60,
  ticks: 0,
  loaded: false,
  loadedFile: null,
  paused: false,
  extRamUpdated: false,
  canvas: {
    show: false,
    scale: 3,
  },
  rewind: {
    minTicks: 0,
    maxTicks: 0,
  },
  files: {
    show: true,
    selected: 0,
    list: []
  }
};

let vm = new Vue({
  el: '.main',
  data: data,
  created: function() {
    setInterval(() => {
      this.fps = emulator ? emulator.fps : 60;
    }, 500);
    setInterval(() => {
      if (this.extRamUpdated) {
        this.updateExtRam();
        this.extRamUpdated = false;
      }
    }, 1000);
    this.readFiles();
  },
  mounted: function() {
    $('.main').classList.add('ready');
  },
  computed: {
    canvasWidthPx: function() {
      return (160 * this.canvas.scale) + 'px';
    },
    canvasHeightPx: function() {
      return (144 * this.canvas.scale) + 'px';
    },
    rewindTime: function() {
      const zeroPadLeft = (num, width) => ('' + (num | 0)).padStart(width, '0');
      const ticks = this.ticks;
      const hr = (ticks / (60 * 60 * CPU_TICKS_PER_SECOND)) | 0;
      const min = zeroPadLeft((ticks / (60 * CPU_TICKS_PER_SECOND)) % 60, 2);
      const sec = zeroPadLeft((ticks / CPU_TICKS_PER_SECOND) % 60, 2);
      const ms = zeroPadLeft((ticks / (CPU_TICKS_PER_SECOND / 1000)) % 1000, 3);
      return `${hr}:${min}:${sec}.${ms}`;
    },
    pauseLabel: function() {
      return this.paused ? 'resume' : 'pause';
    },
    isFilesListEmpty: function() {
      return this.files.list.length == 0;
    },
    loadedFileName: function() {
      return this.loadedFile ? this.loadedFile.name : '';
    },
    selectedFile: function() {
      return this.files.list[this.files.selected];
    },
    selectedFileHasImage: function() {
      const file = this.selectedFile;
      return file && file.image;
    },
    selectedFileImageSrc: function() {
      if (!this.selectedFileHasImage) return '';
      return this.selectedFile.image;
    },
  },
  watch: {
    paused: function(newPaused, oldPaused) {
      if (!emulator) return;
      if (newPaused == oldPaused) return;
      if (newPaused) {
        emulator.pause();
        this.updateTicks();
        this.rewind.minTicks = emulator.rewind.oldestTicks;
        this.rewind.maxTicks = emulator.rewind.newestTicks;
      } else {
        emulator.resume();
      }
    },
  },
  methods: {
    updateTicks: function() {
      this.ticks = emulator.ticks;
    },
    togglePause: function() {
      if (!this.loaded) return;
      this.paused = !this.paused;
    },
    rewindTo: function(event) {
      if (!emulator) return;
      emulator.rewindToTicks(+event.target.value);
      this.updateTicks();
    },
    selectFile: function(index) {
      this.files.selected = index;
    },
    playFile: async function(file) {
      const [romBuffer, extRamBuffer] = await Promise.all([
        readFile(file.rom),
        file.extRam ? readFile(file.extRam) : Promise.resolve(null)
      ]);
      this.paused = false;
      this.loaded = true;
      this.canvas.show = true;
      this.files.show = false;
      this.loadedFile = file;
      Emulator.start(romBuffer, extRamBuffer);
    },
    deleteFile: async function(file) {
      const db = await dbPromise;
      const tx = db.transaction('games', 'readwrite');
      const cursor = await tx.objectStore('games').openCursor(file.sha1);
      if (!cursor) return;
      cursor.delete();
      await tx.complete;
      const index = this.files.list.findIndex(x => x.sha1 === file.sha1);
      if (index < 0) return;
      this.files.list.splice(index, 1);
      if (this.loadedFile && this.loadedFile.sha1 === file.sha1) {
        this.loaded = false;
        this.loadedFile = null;
        this.paused = true;
        this.canvas.show = false;
        Emulator.stop();
      }
    },
    uploadClicked: function() {
      $('#upload').click();
    },
    uploadFile: async function(event) {
      const file = event.target.files[0];
      const [db, buffer] = await Promise.all([dbPromise, readFile(file)]);
      const sha1 = SHA1Digest(buffer);
      const name = file.name;
      const rom = new Blob([buffer]);
      const data = {sha1, name, rom, modified: new Date};
      const tx = db.transaction('games', 'readwrite');
      tx.objectStore('games').add(data)
      await tx.complete;
      this.files.list.push(data);
    },
    updateExtRam: async function() {
      if (!emulator) return;
      const extRamBlob = new Blob([emulator.getExtRam()]);
      const imageDataURL = $('canvas').toDataURL();
      const db = await dbPromise;
      const tx = db.transaction('games', 'readwrite');
      const cursor = await tx.objectStore('games').openCursor(
          this.loadedFile.sha1);
      if (!cursor) return;
      Object.assign(this.loadedFile, cursor.value);
      this.loadedFile.extRam = extRamBlob;
      this.loadedFile.image = imageDataURL;
      this.loadedFile.modified = new Date;
      cursor.update(this.loadedFile);
      return tx.complete;
    },
    toggleOpenDialog: function() {
      this.files.show = !this.files.show;
      if (this.files.show) {
        this.paused = true;
      }
    },
    readFiles: async function() {
      this.files.list.length = 0;
      const db = await dbPromise;
      const tx = db.transaction('games');
      tx.objectStore('games').iterateCursor(cursor => {
        if (!cursor) return;
        this.files.list.push(cursor.value);
        cursor.continue();
      });
      return tx.complete;
    },
    prettySize: function(size) {
      if (size >= 1024 * 1024) {
        return `${(size / (1024 * 1024)).toFixed(1)}Mib`;
      } else if (size >= 1024) {
        return `${(size / 1024).toFixed(1)}Kib`;
      } else {
        return `${size}b`;
      }
    },
    prettyDate: function(date) {
      const options = {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric'
      };
      return date.toLocaleDateString(undefined, options);
    },
  }
});

(function bindKeyInput() {
  function keyRewind(e, isKeyDown) {
    if (emulator.isRewinding !== isKeyDown) {
      if (isKeyDown) {
        vm.paused = true;
        emulator.autoRewind = true;
      } else {
        emulator.autoRewind = false;
        vm.paused = false;
      }
    }
  }

  const keyFuncs = {
    'ArrowDown': _set_joyp_down,
    'ArrowLeft': _set_joyp_left,
    'ArrowRight': _set_joyp_right,
    'ArrowUp': _set_joyp_up,
    'KeyZ': _set_joyp_B,
    'KeyX': _set_joyp_A,
    'Enter': _set_joyp_start,
    'Tab': _set_joyp_select,
    'Backspace': keyRewind,
    'Space': (e, isKeyDown) => { if (isKeyDown) vm.togglePause(); },
  };

  const makeKeyFunc = isKeyDown => {
    return event => {
      if (!emulator) return;
      if (event.code in keyFuncs) {
        keyFuncs[event.code](emulator.e, isKeyDown);
        event.preventDefault();
      }
    };
  };

  window.addEventListener('keydown', makeKeyFunc(true));
  window.addEventListener('keyup', makeKeyFunc(false));
})();

function makeWasmBuffer(ptr, size) {
  return new Uint8Array(Module.buffer, ptr, size);
}

class Emulator {
  static start(romBuffer, extRamBuffer) {
    Emulator.stop();
    emulator = new Emulator(romBuffer, extRamBuffer);
    emulator.run();
  }

  static stop() {
    if (emulator) {
      emulator.destroy();
      emulator = null;
    }
  }

  constructor(romBuffer, extRamBuffer) {
    this.romDataPtr = _malloc(romBuffer.byteLength);
    makeWasmBuffer(this.romDataPtr, romBuffer.byteLength)
        .set(new Uint8Array(romBuffer));
    this.e = _emulator_new_simple(
        this.romDataPtr, romBuffer.byteLength, Audio.ctx.sampleRate,
        AUDIO_FRAMES);
    if (this.e == 0) {
      throw new Error('Invalid ROM.');
    }

    this.audio = new Audio(this.e);
    this.video = new Video(this.e, $('canvas'));
    this.rewind = new Rewind(this.e);
    this.rewindIntervalId = 0;

    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.fps = 60;

    if (extRamBuffer) {
      this.loadExtRam(extRamBuffer);
    }
  }

  destroy() {
    this.cancelAnimationFrame();
    clearInterval(this.rewindIntervalId);
    this.rewind.destroy();
    _emulator_delete(this.e);
    _free(this.romDataPtr);
  }

  withNewFileData(cb) {
    const fileDataPtr = _ext_ram_file_data_new(this.e);
    const buffer = makeWasmBuffer(
        _get_file_data_ptr(fileDataPtr), _get_file_data_size(fileDataPtr));
    const result = cb(fileDataPtr, buffer);
    _file_data_delete(fileDataPtr);
    return result;
  }

  loadExtRam(extRamBuffer) {
    this.withNewFileData((fileDataPtr, buffer) => {
      if (buffer.byteLength === extRamBuffer.byteLength) {
        buffer.set(new Uint8Array(extRamBuffer));
        _emulator_read_ext_ram(this.e, fileDataPtr);
      }
    });
  }

  getExtRam() {
    return this.withNewFileData((fileDataPtr, buffer) => {
      _emulator_write_ext_ram(this.e, fileDataPtr);
      return new Uint8Array(buffer);
    });
  }

  get isPaused() {
    return this.rafCancelToken === null;
  }

  pause() {
    if (!this.isPaused) {
      this.cancelAnimationFrame();
      this.audio.pause();
      this.beginRewind();
    }
  }

  resume() {
    if (this.isPaused) {
      this.endRewind();
      this.requestAnimationFrame();
      this.audio.resume();
    }
  }

  get isRewinding() {
    return this.rewind.isRewinding;
  }

  beginRewind() {
    this.rewind.beginRewind();
  }

  rewindToTicks(ticks) {
    if (this.rewind.rewindToTicks(ticks)) {
      this.runUntil(ticks);
      this.video.renderTexture();
    }
  }

  endRewind() {
    this.rewind.endRewind();
    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.audio.startSec = 0;
  }

  set autoRewind(enabled) {
    if (enabled) {
      this.rewindIntervalId = setInterval(() => {
        const oldest = this.rewind.oldestTicks;
        const start = this.ticks;
        const delta =
            REWIND_FACTOR * REWIND_UPDATE_MS / 1000 * CPU_TICKS_PER_SECOND;
        const rewindTo = Math.max(oldest, start - delta);
        this.rewindToTicks(rewindTo);
        vm.ticks = emulator.ticks;
      }, REWIND_UPDATE_MS);
    } else {
      clearInterval(this.rewindIntervalId);
      this.rewindIntervalId = 0;
    }
  }

  requestAnimationFrame() {
    this.rafCancelToken = requestAnimationFrame(this.rafCallback.bind(this));
  }

  cancelAnimationFrame() {
    cancelAnimationFrame(this.rafCancelToken);
    this.rafCancelToken = null;
  }

  run() {
    this.requestAnimationFrame();
  }

  get ticks() {
    return _emulator_get_ticks_f64(this.e);
  }

  runUntil(ticks) {
    while (true) {
      const event = _emulator_run_until_f64(this.e, ticks);
      if (event & EVENT_NEW_FRAME) {
        this.rewind.pushBuffer();
        this.video.uploadTexture();
      }
      if ((event & EVENT_AUDIO_BUFFER_FULL) && !this.isRewinding) {
        this.audio.pushBuffer();
      }
      if (event & EVENT_UNTIL_TICKS) {
        break;
      }
    }
    if (_emulator_was_ext_ram_updated(this.e)) {
      vm.extRamUpdated = true;
    }
  }

  rafCallback(startMs) {
    this.requestAnimationFrame();
    let deltaSec = 0;
    if (!this.isRewinding) {
      const startSec = startMs / 1000;
      deltaSec = Math.max(startSec - (this.lastRafSec || startSec), 0);
      const startTicks = this.ticks;
      const deltaTicks =
          Math.min(deltaSec, MAX_UPDATE_SEC) * CPU_TICKS_PER_SECOND;
      const runUntilTicks = (startTicks + deltaTicks - this.leftoverTicks);
      this.runUntil(runUntilTicks);
      this.leftoverTicks = (this.ticks - runUntilTicks) | 0;
      this.lastRafSec = startSec;
    }
    const lerp = (from, to, alpha) => (alpha * from) + (1 - alpha) * to;
    this.fps = lerp(this.fps, Math.min(1 / deltaSec, 10000), 0.3);
    this.video.renderTexture();
  }
}

class Audio {
  constructor(e) {
    this.buffer =
        makeWasmBuffer(_get_audio_buffer_ptr(e), _get_audio_buffer_capacity(e));
    this.startSec = 0;
    this.resume();
  }

  get sampleRate() { return Audio.ctx.sampleRate; }

  pushBuffer() {
    const nowSec = Audio.ctx.currentTime;
    const nowPlusLatency = nowSec + AUDIO_LATENCY_SEC;
    this.startSec = (this.startSec || nowPlusLatency);
    if (this.startSec >= nowSec) {
      const buffer = Audio.ctx.createBuffer(2, AUDIO_FRAMES, this.sampleRate);
      const channel0 = buffer.getChannelData(0);
      const channel1 = buffer.getChannelData(1);
      for (let i = 0; i < AUDIO_FRAMES; i++) {
        channel0[i] = this.buffer[2 * i] / 127.5 - 1;
        channel1[i] = this.buffer[2 * i + 1] / 127.5 - 1;
      }
      const bufferSource = Audio.ctx.createBufferSource();
      bufferSource.buffer = buffer;
      bufferSource.connect(Audio.ctx.destination);
      bufferSource.start(this.startSec);
      const bufferSec = AUDIO_FRAMES / this.sampleRate;
      this.startSec += bufferSec;
    } else {
      console.log(
          'Resetting audio (' + this.startSec.toFixed(2) + ' < ' +
          nowSec.toFixed(2) + ')');
      this.startSec = nowPlusLatency;
    }
  }

  pause() {
    Audio.ctx.suspend();
  }

  resume() {
    Audio.ctx.resume();
  }
}

Audio.ctx = new AudioContext;

class Video {
  constructor(e, el) {
    try {
      this.renderer = new WebGLRenderer(el);
    } catch (error) {
      console.log(`Error creating WebGLRenderer: ${error}`);
      this.renderer = new Canvas2DRenderer(el);
    }
    this.buffer =
        makeWasmBuffer(_get_frame_buffer_ptr(e), _get_frame_buffer_size(e));
  }

  uploadTexture() {
    this.renderer.uploadTexture(this.buffer);
  }

  renderTexture() {
    this.renderer.renderTexture();
  }
}

class Canvas2DRenderer {
  constructor(el) {
    this.ctx = el.getContext('2d');
    this.imageData = this.ctx.createImageData(el.width, el.height);
  }

  renderTexture() {
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  uploadTexture(buffer) {
    this.imageData.data.set(buffer);
  }
}

class WebGLRenderer {
  constructor(el) {
    const gl = this.gl = el.getContext('webgl', {preserveDrawingBuffer: true});
    if (gl === null) {
      throw new Error('unable to create webgl context');
    }

    const w = SCREEN_WIDTH / 256;
    const h = SCREEN_HEIGHT / 256;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  0, h,
      +1, -1,  w, h,
      -1, +1,  0, 0,
      +1, +1,  w, 0,
    ]), gl.STATIC_DRAW);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    function compileShader(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`compileShader failed: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER,
       `attribute vec2 aPos;
        attribute vec2 aTexCoord;
        varying highp vec2 vTexCoord;
        void main(void) {
          gl_Position = vec4(aPos, 0.0, 1.0);
          vTexCoord = aTexCoord;
        }`);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER,
       `varying highp vec2 vTexCoord;
        uniform sampler2D uSampler;
        void main(void) {
          gl_FragColor = texture2D(uSampler, vTexCoord);
        }`);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const aPos = gl.getAttribLocation(program, 'aPos');
    const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
    const uSampler = gl.getUniformLocation(program, 'uSampler');

    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, gl.FALSE, 16, 0);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, gl.FALSE, 16, 8);
    gl.uniform1i(uSampler, 0);
  }

  renderTexture() {
    this.gl.clearColor(0.5, 0.5, 0.5, 1.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  uploadTexture(buffer) {
    this.gl.texSubImage2D(
        this.gl.TEXTURE_2D, 0, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, this.gl.RGBA,
        this.gl.UNSIGNED_BYTE, buffer);
  }
}

class Rewind {
  constructor(e) {
    this.e = e;
    this.joypadBufferPtr = _joypad_new();
    this.statePtr = 0;
    this.bufferPtr = _rewind_new_simple(
        e, REWIND_FRAMES_PER_BASE_STATE, REWIND_BUFFER_CAPACITY);
    _emulator_set_default_joypad_callback(e, this.joypadBufferPtr);
  }

  destroy() {
    _rewind_delete(this.bufferPtr);
    _joypad_delete(this.joypadBufferPtr);
  }

  get oldestTicks() {
    return _rewind_get_oldest_ticks_f64(this.bufferPtr);
  }

  get newestTicks() {
    return _rewind_get_newest_ticks_f64(this.bufferPtr);
  }

  pushBuffer() {
    if (!this.isRewinding) {
      _rewind_append(this.bufferPtr, this.e);
    }
  }

  get isRewinding() {
    return this.statePtr !== 0;
  }

  beginRewind() {
    if (this.isRewinding) return;
    this.statePtr = _rewind_begin(this.e, this.bufferPtr, this.joypadBufferPtr);
  }

  rewindToTicks(ticks) {
    if (!this.isRewinding) return;
    return _rewind_to_ticks_wrapper(this.statePtr, ticks) === RESULT_OK;
  }

  endRewind() {
    if (!this.isRewinding) return;
    _emulator_set_default_joypad_callback(this.e, this.joypadBufferPtr);
    _rewind_end(this.statePtr);
    this.statePtr = 0;
  }
}
