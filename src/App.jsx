import React, { useEffect, useState, useRef, useCallback } from "react";
import JSZip from "jszip";

import * as Unrar from "node-unrar-js";
import unrarWasmUrl from "node-unrar-js/esm/js/unrar.wasm?url";

// Совместимые хелперы (под разные версии)
const createExtractorFromData =
  Unrar.createExtractorFromData || Unrar.default?.createExtractorFromData;
const setOptions =
  Unrar.setOptions || Unrar.default?.setOptions;

// Передаём URL wasm (если метод доступен)
setOptions?.({ wasmBinaryUrl: unrarWasmUrl });


/* =============================
   IndexedDB (без авторизации)
============================= */
const DB_NAME = "speedreader-db";
const DB_VERSION = 1;
const STORES = { BOOKS: "books" };
let dbPromise = null;

const getDB = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error || new Error("IndexedDB error"));
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORES.BOOKS)) {
          db.createObjectStore(STORES.BOOKS, { keyPath: "id", autoIncrement: true });
        }
      };
    });
  }
  return dbPromise;
};

const db = {
  async getAll(store) {
    const inst = await getDB();
    return new Promise((res, rej) => {
      const tx = inst.transaction(store, "readonly");
      const r = tx.objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async put(store, val) {
    const inst = await getDB();
    return new Promise((res, rej) => {
      const tx = inst.transaction(store, "readwrite");
      const r = tx.objectStore(store).put(val);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async delete(store, key) {
    const inst = await getDB();
    return new Promise((res, rej) => {
      const tx = inst.transaction(store, "readwrite");
      const r = tx.objectStore(store).delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
};

/* =============================
   FB2: декодирование и парсинг
============================= */
function decodeFB2(arrayBuffer) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(arrayBuffer);
  const win = new TextDecoder("windows-1251", { fatal: false }).decode(arrayBuffer);
  const utf8Cyr = (utf8.match(/[а-яА-ЯёЁ]/g) || []).length;
  const winCyr = (win.match(/[а-яА-ЯёЁ]/g) || []).length;
  return winCyr > utf8Cyr * 2 ? win : utf8;
}

function parseFB2Text(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid FB2");
  const bodies = doc.getElementsByTagName("body");
  if (!bodies.length) return (doc.documentElement && doc.documentElement.textContent) || "";

  const nodes = [];
  for (let b of bodies) {
    nodes.push(
      ...Array.from(b.querySelectorAll("p, title, subtitle, epigraph, poem, v"))
        .map((n) => n.textContent.trim())
        .filter(Boolean)
    );
  }
  return nodes.join(" \n\n ");
}

/* =============================
   Хук скорочтения (шаг — символами или парами)
============================= */
function useSpeedReader(words, wpm, charLimit, stepSize = 1) {
  const [position, setPosition] = useState(0); // индекс текущего слова (или начала пары)
  const [isPlaying, setIsPlaying] = useState(false);
  const intervalRef = useRef(null);

  const stopInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }, []);

  // Собираем текстовый фрагмент длиной не более charLimit символов, целыми словами
  const getChunkText = useCallback(() => {
    if (words.length === 0) return "";
    let buffer = [];
    let totalChars = 0;
    let i = position;

    while (i < words.length) {
      const w = words[i];
      const wLen = w.length + 1; // слово + пробел
      if (totalChars + wLen > charLimit) {
        if (buffer.length === 0) {
          buffer.push(w);
          i++;
        }
        break;
      }
      buffer.push(w);
      totalChars += wLen;
      i++;
    }
    return buffer.join(" ");
  }, [words, position, charLimit]);

  const displayedText = getChunkText();

  // Автопролистывание
  useEffect(() => {
    if (!isPlaying || words.length === 0) {
      stopInterval();
      return;
    }
    const msPerChunk = Math.max(1, Math.round(60000 / Math.max(1, wpm)));
    stopInterval();

    intervalRef.current = setInterval(() => {
      setPosition((p) => {
        let next = p;
        if (stepSize === 1) {
          // режим «по символам» (старый)
          let totalChars = 0;
          while (next < words.length) {
            const len = words[next].length + 1;
            if (totalChars + len > charLimit) break;
            totalChars += len;
            next++;
          }
          if (next === p) next = Math.min(words.length, p + 1);
        } else {
          // режим «парами»
          next = Math.min(words.length, p + stepSize);
        }

        if (next >= words.length) {
          stopInterval();
          setIsPlaying(false);
          return p;
        }
        return next;
      });
    }, msPerChunk);

    return () => stopInterval();
  }, [isPlaying, wpm, charLimit, words, stepSize, stopInterval]);

  const togglePlay = useCallback(() => {
    if (words.length > 0) setIsPlaying((s) => !s);
  }, [words.length]);

  const resetPosition = useCallback(() => {
    setPosition(0);
    setIsPlaying(false);
  }, []);

  const jumpToPosition = useCallback(
    (newPos) => setPosition(Math.max(0, Math.min(newPos, Math.max(0, words.length - 1)))),
    [words.length]
  );

  return {
    position,
    isPlaying,
    displayedText,
    togglePlay,
    resetPosition,
    jumpToPosition,
    setIsPlaying,
    setPosition,
  };
}

/* =============================
   Список книг (главная)
============================= */
function BooksView({ books, onFileUpload, onOpenBook, onDeleteBook, isDark, toggleTheme }) {
  const fileRef = useRef(null);
  return (
    <div
      className="min-h-screen flex flex-col items-center p-4 transition-colors duration-300"
      style={{ backgroundColor: "var(--bg-color)", color: "var(--text-color)" }}
    >
      <header className="w-full max-w-4xl flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">📚 Моя библиотека</h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => fileRef.current?.click()}
            className="px-3 py-2 rounded bg-green-600 hover:bg-green-500 text-white"
          >
            Загрузить книгу
          </button>

          <button onClick={toggleTheme} className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600">
            {isDark ? "☀️ День" : "🌙 Ночь"}
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".fb2,.zip,.rar"
            className="hidden"
            onChange={async (e) => {
              if (e.target.files?.[0]) {
                await onFileUpload(e.target.files[0]);
                e.target.value = "";
              }
            }}
          />
        </div>
      </header>

      <main className="w-full max-w-4xl mx-auto">
        <section
          className={`p-4 rounded-lg transition-colors duration-300 ${
            isDark ? "bg-gray-800 text-gray-100" : "bg-white text-gray-900 border border-gray-300"
          }`}
        >
          <h2 className="font-semibold text-lg mb-3">Сохранённые книги</h2>
          <ul className="space-y-2">
            {books.length === 0 && (
              <li className="text-gray-400 text-center py-4">
                Ваша библиотека пуста. Загрузите книгу, чтобы начать.
              </li>
            )}
            {books.map((b) => {
              const percent =
                b.words && b.words.length
                  ? ((Math.max(0, Math.min(b.progress || 0, b.words.length - 1)) / b.words.length) * 100).toFixed(1)
                  : "0.0";
              return (
                <li
                  key={b.id}
                  className={`flex items-center justify-between p-3 rounded transition-colors ${
                    isDark ? "bg-gray-700 hover:bg-gray-600" : "bg-gray-200 hover:bg-gray-300 text-gray-900"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{b.title}</div>
                    {b.words?.length > 0 && (
                      <div className="text-xs opacity-75 mt-1">Прочитано: {percent}%</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <button
                      onClick={() => onOpenBook(b)}
                      className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white"
                    >
                      Читать
                    </button>
                    <button
                      onClick={() => onDeleteBook(b.id)}
                      className="px-4 py-2 rounded bg-red-700 hover:bg-red-600 text-white"
                    >
                      Удалить
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </div>
  );
}

/* =============================
   Режим чтения
============================= */
/* =============================
   Вёрстка: режим чтения (фикс центрирования)
============================= */
/* =============================
   Вёрстка: режим чтения (центр + Угол зрения)
============================= */
function ReadingView({ readerProps, onBack, onSeek, isDark, toggleTheme }) {
  const {
    // базовый ридер
    displayedText,
    isPlaying,
    togglePlay,
    wpm, setWpm,
    charLimit, setCharLimit,
    fontSize, setFontSize,
    isBold, setIsBold,
    position,
    wordsLength,
    progressPercent,
    isUpsideDown, setIsUpsideDown,
    hideVowels, setHideVowels,
    halfVisible, setHalfVisible,

    // пары/синхронизация
    words = [],
    setIsPlaying,
    jumpToPosition,
  } = readerProps;

  // НОВОЕ: состояние компактного режима
  const [isCompactUI, setIsCompactUI] = React.useState(false);

  // Настройки для изменения скорости
  const WPM_MIN = 60;
  const WPM_MAX = 1200;
  const WPM_STEP = 10;

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const decWpm = () => setWpm(prev => clamp(prev - WPM_STEP, WPM_MIN, WPM_MAX));
  const incWpm = () => setWpm(prev => clamp(prev + WPM_STEP, WPM_MIN, WPM_MAX));
// ---- Символов (ширина текста) ----
const CHAR_MIN = 10;
const CHAR_MAX = 100;
const CHAR_STEP = 5;
const decChars = () => setCharLimit(v => Math.max(CHAR_MIN, v - CHAR_STEP));
const incChars = () => setCharLimit(v => Math.min(CHAR_MAX, v + CHAR_STEP));
  /* ===== Константы тренировки ===== */
  const TRAIN_MIN = 10;
  const TRAIN_MAX = 550;
  const TRAIN_STEP = 10;
  const TRAIN_EVERY_PAIRS = 3; // каждые 3 пары (6 слов)

  /* ===== Состояния ===== */
  const [isAngleMode, setIsAngleMode] = React.useState(false);
  const [pairGap, setPairGap] = React.useState(500); // px (ширина центрального зазора)
  const [pairPos, setPairPos] = React.useState(0);   // индекс ЛЕВОГО слова пары
  const [isPairPlaying, setIsPairPlaying] = React.useState(false);
  const pairTimerRef = React.useRef(null);

  const [isTraining, setIsTraining] = React.useState(false);
  const [trainingDir, setTrainingDir] = React.useState(1); // +1 растём, -1 уменьшаем
  const pairsSinceStepRef = React.useRef(0);

  const [showGuide, setShowGuide] = React.useState(false); // оптический ориентир (центральная линия)

  // refs для стабильности
  const positionRef = React.useRef(position);
  React.useEffect(() => { positionRef.current = position; }, [position]);

  const lastSyncedPosRef = React.useRef(-1);
  // ВАЖНО: не авто-синхронизируем с pairPos, управляем вручную в нужных местах
  const prevPairPosRef = React.useRef(0);

  // текущая пара
  const leftIndex = Math.max(0, pairPos - (pairPos % 2));
  const wLeft  = words[leftIndex] || "";
  const wRight = words[leftIndex + 1] || "";

  /* ===== Таймер пары ===== */
  const stopPairTimer = React.useCallback(() => {
    if (pairTimerRef.current) clearInterval(pairTimerRef.current);
    pairTimerRef.current = null;
  }, []);

  const startPairTimer = React.useCallback(() => {
    stopPairTimer();
    const msPerPair = Math.max(1, Math.round(60000 / Math.max(1, wpm)));
    pairTimerRef.current = setInterval(() => {
      setPairPos((p) => {
        const next = p + 2;
        if (next >= words.length) {
          stopPairTimer();
          setIsPairPlaying(false);
          return p;
        }
        return next;
      });
    }, msPerPair);
  }, [stopPairTimer, wpm, words.length]);
// ==== Fullscreen helpers ====
const [isFullscreen, setIsFullscreen] = React.useState(false);

const reqFullscreen = (el) =>
  (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);

const exitFullscreen = () =>
  (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen)?.call(document);

React.useEffect(() => {
  const onChange = () =>
    setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    document.removeEventListener("webkitfullscreenchange", onChange);
  };
}, []);

const toggleFullscreen = () => {
  const el = document.documentElement; // можно поменять на контейнер ридера
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreen();
  } else {
    reqFullscreen(el)?.catch(() => {
      // На некоторых версиях iOS Safari настоящий fullscreen недоступен внутри браузера
      if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        // Мягкая подсказка, если не удалось
        console.info("Совет: Добавьте приложение на экран Домой (Поделиться → На экран Домой) для настоящего полноэкранного режима.");
      }
    });
  }
};

  /* ===== Вход/выход «Угол зрения» ===== */
  React.useEffect(() => {
    if (isAngleMode) {
      setIsPlaying?.(false);
      const pos = positionRef.current;
      const evenFromPosition = Math.max(0, pos - (pos % 2));
      setPairPos(evenFromPosition);
      setIsPairPlaying(false);
      stopPairTimer();
      lastSyncedPosRef.current = -1;
      prevPairPosRef.current = evenFromPosition; // для корректного первого шага тренировки
    } else {
      // выход из угла зрения выключает тренировку
      setIsTraining(false);
      setIsPairPlaying(false);
      stopPairTimer();
      lastSyncedPosRef.current = -1;
    }
  }, [isAngleMode, setIsPlaying, stopPairTimer]);

  /* ===== Переключатель тренировки (кнопка) ===== */
  const toggleTraining = React.useCallback(() => {
    if (!isTraining) {
      if (!isAngleMode) setIsAngleMode(true);
      setIsPlaying?.(false);
      pairsSinceStepRef.current = 0;
      setTrainingDir(1);
      setPairGap(TRAIN_MIN);
      setIsTraining(true);
      setIsPairPlaying(true);
      prevPairPosRef.current = leftIndex; // базовая точка для счётчика
      setShowGuide(true);                  // в тренировке ориентир включаем по умолчанию
    } else {
      setIsTraining(false);
      setIsPairPlaying(false);
      setIsAngleMode(false); // возврат в обычный режим
    }
  }, [isTraining, isAngleMode, setIsPlaying, leftIndex]);

  /* ===== Таймер пар включён? ===== */
  React.useEffect(() => {
    if (!isAngleMode) return;
    if (isPairPlaying) startPairTimer();
    else stopPairTimer();
    return stopPairTimer;
  }, [isPairPlaying, isAngleMode, startPairTimer, stopPairTimer, wpm]);

  /* ===== Синхронизация глобального прогресса с парой ===== */
  React.useEffect(() => {
    if (!isAngleMode) return;
    if (lastSyncedPosRef.current !== leftIndex) {
      lastSyncedPosRef.current = leftIndex;
      jumpToPosition(leftIndex);
    }
  }, [isAngleMode, leftIndex, jumpToPosition]);

  /* ===== ЛОГИКА ТРЕНИРОВКИ: шаг каждые 3 пары (авто и ручной шаг) ===== */
  React.useEffect(() => {
    // если не тренировка — просто обновляем маркер и выходим
    if (!(isAngleMode && isTraining)) {
      prevPairPosRef.current = pairPos;
      return;
    }

    // реагируем ТОЛЬКО на движение вперёд на новую пару
    if (pairPos > prevPairPosRef.current) {
      pairsSinceStepRef.current += 1;

      if (pairsSinceStepRef.current >= TRAIN_EVERY_PAIRS) {
        pairsSinceStepRef.current = 0;
        setPairGap((g) => {
          let next = g + trainingDir * TRAIN_STEP;
          if (next >= TRAIN_MAX) { next = TRAIN_MAX; setTrainingDir(-1); }
          else if (next <= TRAIN_MIN) { next = TRAIN_MIN; setTrainingDir(1); }
          return next;
        });
      }
      // фиксируем новую «последнюю» пару
      prevPairPosRef.current = pairPos;
    }
  }, [pairPos, isAngleMode, isTraining, trainingDir]);

  /* ===== Общие стили текста ===== */
  const textCommonStyle = {
    display: "block",
    fontSize: `${fontSize}px`,
    fontWeight: isBold ? "bold" : "normal",
    lineHeight: 1.25,
    wordBreak: "break-word",
    maxWidth: "100%",
    clipPath: halfVisible ? "inset(0 0 35% 0)" : "inset(0 0 0 0)",
    transition: "clip-path 0.3s ease",
    transform: isUpsideDown ? "rotate(180deg)" : "none",
    transformOrigin: "50% 50%",
  };

  /* ===== Старт/Пауза ===== */
  const handleStartPause = React.useCallback(() => {
    if (isAngleMode) {
      setIsPairPlaying((v) => !v); // пауза/пуск для угла/тренировки
    } else {
      togglePlay();
    }
  }, [isAngleMode, togglePlay]);

  /* ===== Клавиатура ===== */
  React.useEffect(() => {
    if (!readerProps || !onSeek) return;
    const { words, charLimit, jumpToPosition, setIsPlaying } = readerProps;
    if (!words || words.length === 0) return;

    const clampLocal = (v, min, max) => Math.max(min, Math.min(max, v));

    const getNextChunkStart = (pos) => {
      let next = pos, total = 0;
      while (next < words.length) {
        const len = words[next].length + 1;
        if (total + len > charLimit) break;
        total += len; next++;
      }
      if (next === pos) next = Math.min(words.length, pos + 1);
      return next;
    };

    const getPrevChunkStart = (pos) => {
      let prev = pos, total = 0;
      while (prev > 0) {
        const len = words[prev - 1].length + 1;
        if (total + len > charLimit) break;
        total += len; prev--;
      }
      if (prev === pos) prev = Math.max(0, pos - 1);
      return prev;
    };

    const onKey = (e) => {
      // WPM вверх/вниз — везде
      if (e.code === "ArrowUp") {
        e.preventDefault(); setWpm((w) => clampLocal(w + 10, 20, 1000)); return;
      }
      if (e.code === "ArrowDown") {
        e.preventDefault(); setWpm((w) => clampLocal(w - 10, 20, 1000)); return;
      }

      // Пробел — пуск/пауза
      if (e.code === "Space") { e.preventDefault(); handleStartPause(); return; }

      if (isAngleMode) {
        // ручная навигация по парам
        if (e.code === "ArrowRight") {
          e.preventDefault();
          setIsPairPlaying(false);
          setPairPos((p) => Math.min(p + 2, Math.max(0, words.length - 2)));
          return;
        }
        if (e.code === "ArrowLeft") {
          e.preventDefault();
          setIsPairPlaying(false);
          setPairPos((p) => Math.max(0, p - 2));
          return;
        }
        return;
      }

      // обычный режим
      if (e.code === "ArrowRight") {
        e.preventDefault();
        setIsPlaying(false);
        jumpToPosition(getNextChunkStart(position));
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        setIsPlaying(false);
        jumpToPosition(getPrevChunkStart(position));
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readerProps, onSeek, position, isAngleMode, handleStartPause, setWpm]);

  /* ===== Хелпер для классов кнопок (активная = синяя) ===== */
  const btnClass = (active) =>
    `px-4 py-2 rounded ${active ? "bg-blue-600 text-white" : "bg-gray-700"} hover:bg-gray-600 transition`;

  /* ===== Разметка ===== */
  return (
    <div
      className="min-h-screen flex flex-col items-center p-4 transition-colors duration-300"
      style={{ backgroundColor: "var(--bg-color)", color: "var(--text-color)" }}
    >
      {/* Центрированная зона чтения */}
      <main className="flex-1 w-full flex items-center justify-center">
        <div
          className="rounded-2xl shadow-lg transition-colors duration-300"
          style={{
            backgroundColor: "var(--bg-color)",
            color: "var(--text-color)",
            width: "90vw",
            height: "35vh",
            display: "grid",
            alignItems: "center",
            justifyItems: "center",
            textAlign: "center",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* ОПТИЧЕСКИЙ ОРИЕНТИР: вертикальная линия по центру */}
          {showGuide && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: "50%",
                width: "1px",
                background: isDark ? "rgba(59,130,246,0.6)" : "rgba(37,99,235,0.7)",
                transform: "translateX(-0.5px)",
                pointerEvents: "none",
              }}
            />
          )}

          {/* Обычный режим */}
          {!isAngleMode && (
            <span style={textCommonStyle}>
              {hideVowels ? renderWithHiddenVowels(displayedText || "...") : displayedText || "..."}
            </span>
          )}

          {/* Угол зрения / Тренировка — 3 колонки: левая | GAP | правая (центр устойчив) */}
          {isAngleMode && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `1fr ${pairGap}px 1fr`,
                alignItems: "center",
                width: "100%",
                transform: isUpsideDown ? "rotate(180deg)" : "none",
                transformOrigin: "50% 50%",
              }}
            >
              {/* Левая колонка к центру (правый край) */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <span style={{ ...textCommonStyle, textAlign: "right" }}>{wLeft}</span>
              </div>

              {/* Центральный зазор фиксированной ширины */}
              <div aria-hidden="true" />

              {/* Правая колонка от центра (левый край) */}
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <span style={{ ...textCommonStyle, textAlign: "left" }}>{wRight}</span>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Прогресс и управление */}
      <footer className="w-full max-w-4xl">
        {/* Прогресс — всегда. В «Угол зрения» навигация отключена. */}
        <div className="mb-4">
          <div
            className={`flex justify-between items-center text-sm mb-1 px-1 transition-colors ${
              isDark ? "text-gray-400" : "text-gray-700"
            }`}
          >
            <span>Прогресс</span>
            <span>{progressPercent}%</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                onSeek(Math.max(0, position - Math.max(1, Math.round(wordsLength * 0.002))))
              }
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
              disabled={isAngleMode || wordsLength <= 1}
              aria-label="Шаг назад ~0.2%"
              title="Шаг назад ~0.2%"
            >
              -
            </button>

            <input
              type="range"
              min={0}
              max={wordsLength > 0 ? wordsLength - 1 : 0}
              value={position}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="w-full h-3 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              disabled={isAngleMode}
            />

            <button
              type="button"
              onClick={() =>
                onSeek(
                  Math.min(
                    Math.max(0, wordsLength - 1),
                    position + Math.max(1, Math.round(wordsLength * 0.002))
                  )
                )
              }
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-50"
              disabled={isAngleMode || wordsLength <= 1}
              aria-label="Шаг вперёд ~0.2%"
              title="Шаг вперёд ~0.2%"
            >
              +
            </button>
          </div>
        </div>

{/* Панель управления */}

{/* Кнопка скрытия/показа меню */}
<div className="controls-row" style={{ marginTop: 12 }}>
  <button className="btn" onClick={() => setIsCompactUI(v => !v)}>
    {isCompactUI ? "Показать меню" : "Скрыть меню"}
  </button>

  {/* Кнопка полноэкранного режима */}
<button
  className={btnClass(isFullscreen)}   // даст синий стиль
  onClick={toggleFullscreen}
  aria-pressed={isFullscreen}          // заодно корректная доступность
>
  {isFullscreen ? "Свернуть" : "Развернуть"}
</button>


</div>


{/* === Компактный режим: только Старт + WPM === */}
{isCompactUI && (
  <div className="controls-row mini-panel" style={{ marginTop: 8 }}>
  <button
  className={btnClass(isAngleMode ? isPairPlaying : isPlaying)}
  onClick={handleStartPause}
  aria-pressed={isAngleMode ? isPairPlaying : isPlaying}
>
  {isAngleMode ? (isPairPlaying ? "Пауза" : "Старт") : (isPlaying ? "Пауза" : "Старт")}
</button>


    <div className="controls-row" style={{ alignItems: "center" }}>
      <span>WPM:</span>
      <button className="btn" onClick={decWpm}>–</button>
      <strong>{wpm}</strong>
      <button className="btn" onClick={incWpm}>+</button>
    </div>
  </div>
)}

{/* === Развернутый режим: порядок как на скрине === */}
{!isCompactUI && (
  <>
    {/* 1-я строка: Вернуться | Тема | Старт */}
    <div className="controls-row compactable" style={{ marginTop: 16 }}>
      <button className="btn" onClick={onBack}>Вернуться</button>

      <button className="btn" onClick={toggleTheme}>
        <span className="icon-emoji" aria-hidden="true">
          {isDark ? "🌞" : "🌙"}
        </span>
        {isDark ? "День" : "Ночь"}
      </button>

<button
  className={btnClass(isAngleMode ? isPairPlaying : isPlaying)}
  onClick={handleStartPause}
  aria-pressed={isAngleMode ? isPairPlaying : isPlaying}
>
  {isAngleMode ? (isPairPlaying ? "Пауза" : "Старт") : (isPlaying ? "Пауза" : "Старт")}
</button>

    </div>

    {/* 2-я строка: WPM */}
    <div className="controls-row compactable" style={{ marginTop: 12 }}>
      <span>WPM:</span>
      <button className="btn" onClick={decWpm}>–</button>
      <strong>{wpm}</strong>
      <button className="btn" onClick={incWpm}>+</button>
    </div>

    {/* 3-я строка: Символов (только обычный режим) */}
    {!isAngleMode && (
      <div className="controls-row compactable" style={{ marginTop: 12 }}>
        <span>Символов:</span>
        <button className="btn" onClick={() => setCharLimit(v => Math.max(10, v - 5))}>–</button>
        <strong>{charLimit}</strong>
        <button className="btn" onClick={() => setCharLimit(v => Math.min(100, v + 5))}>+</button>
      </div>
    )}

    {/* 4-я строка: Размер */}
    <div className="controls-row compactable" style={{ marginTop: 12 }}>
      <span>Размер:</span>
      <button className="btn" onClick={() => setFontSize(v => Math.max(12, v - 2))}>–</button>
      <strong>{fontSize}</strong>
      <button className="btn" onClick={() => setFontSize(v => Math.min(120, v + 2))}>+</button>
    </div>

    {/* 5-я строка: тогглы */}
    <div className="controls-row compactable" style={{ marginTop: 12, flexWrap: "wrap" }}>
      <button onClick={() => setIsBold(b => !b)} className={btnClass(isBold)} aria-pressed={isBold}>
        Жирный
      </button>
      <button onClick={() => setIsUpsideDown(v => !v)} className={btnClass(isUpsideDown)} aria-pressed={isUpsideDown}>
        Вверх ногами
      </button>

      <button onClick={() => setHalfVisible(v => !v)} className={btnClass(halfVisible)} aria-pressed={halfVisible}>
        Полтекста
      </button>
      <button
        onClick={() => setShowGuide(v => !v)}
        className={btnClass(showGuide)}
        aria-pressed={showGuide}
        title="Показать центральную линию"
      >
        Ориентир
      </button>
      <button
        onClick={() => setIsAngleMode(m => !m)}
        className={btnClass(isAngleMode)}
        aria-pressed={isAngleMode}
        title="Режим двух слов с зазором"
      >
        Угол зрения
      </button>
      <button
        onClick={toggleTraining}
        className={btnClass(isTraining)}
        aria-pressed={isTraining}
        title="Авто-изменение расстояния каждые 3 пары"
      >
        Тренировка
      </button>
    </div>

    {/* 6-я строка: Расстояние для «Угол зрения» */}
    {isAngleMode && (
      <div className="flex items-center gap-3 mt-2">
        <label className="text-sm">Расстояние:</label>
        <button
          onClick={() => setPairGap(g => Math.max(0, g - 10))}
          className="w-8 h-8 rounded bg-gray-700"
          title="Меньше"
        >
          -
        </button>
        <span className="w-24 text-center">{pairGap}px</span>
        <button
          onClick={() => setPairGap(g => Math.min(1200, g + 10))}
          className="w-8 h-8 rounded bg-gray-700"
          title="Больше"
        >
          +
        </button>
      </div>
    )}
  </>
)}

      </footer>
    </div>
  );
}




/* =============================
   Основной компонент приложения
============================= */
const PHASES = { BOOKS: "books", READING: "reading" };

export default function SpeedReaderApp() {
  const [phase, setPhase] = useState(PHASES.BOOKS);
  const [books, setBooks] = useState([]);
  const [currentBook, setCurrentBook] = useState(null);
  const [words, setWords] = useState([]);

  // Настройки чтения
  const [wpm, setWpm] = useState(300);
  const [charLimit, setCharLimit] = useState(25);
  const [fontSize, setFontSize] = useState(48);
  const [isBold, setIsBold] = useState(false);
  const [isUpsideDown, setIsUpsideDown] = useState(false);
  const [hideVowels, setHideVowels] = useState(false);
  const [halfVisible, setHalfVisible] = useState(false);
  const [isDark, setIsDark] = useState(true);

  // «Угол зрения»
  const [isPeripheral, setIsPeripheral] = useState(false);
  const [peripheralGap, setPeripheralGap] = useState(160); // px

  const pairStep = isPeripheral ? 2 : 1;

  const {
    position,
    isPlaying,
    displayedText,
    togglePlay,
    resetPosition,
    jumpToPosition,
    setIsPlaying,
  } = useSpeedReader(words, wpm, charLimit, pairStep);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      document.body.classList.toggle("dark", next);
      return next;
    });
  }, []);

  // Загрузка списка книг при старте
  useEffect(() => {
    (async () => {
      const all = await db.getAll(STORES.BOOKS);
      setBooks(all);
    })();
  }, []);

  // Автосохранение позиции при закрытии/скрытии
  useEffect(() => {
    const handleSaveOnExit = async () => {
      if (currentBook && currentBook.id != null) {
        const updated = { ...currentBook, progress: position };
        try {
          await db.put(STORES.BOOKS, updated);
          setBooks((arr) => arr.map((b) => (b.id === updated.id ? updated : b)));
        } catch (e) {
          console.error("Не удалось сохранить позицию при выходе:", e);
        }
      }
    };
    const onBeforeUnload = () => handleSaveOnExit();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") handleSaveOnExit();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [currentBook, position]);

  /* ---------- Действия ---------- */

  const handleFileUpload = useCallback(async (file) => {
    try {
      let arrayBuffer = await file.arrayBuffer();
if (/\.zip$/i.test(file.name)) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const fb2Name = Object.keys(zip.files).find((n) => /\.fb2$/i.test(n));
  if (!fb2Name) throw new Error("ZIP не содержит .fb2 файлов");
  arrayBuffer = await zip.files[fb2Name].async("arraybuffer");

} else if (/\.rar$/i.test(file.name)) {
  // 1. Всегда подаём Uint8Array на вход
  const u8Input = new Uint8Array(arrayBuffer);

  // 2. Создаём extractor
  if (typeof createExtractorFromData !== "function") {
    throw new Error("RAR: createExtractorFromData недоступен (импорт не загрузился)");
  }
  const extractor = await createExtractorFromData({ data: u8Input });

  // 3. Получаем список файлов в архиве и ищем первый .fb2
  const { fileHeaders } = extractor.getFileList();
  const fb2Header = fileHeaders.find(h => /\.fb2$/i.test(h.name));
  if (!fb2Header) throw new Error("RAR не содержит .fb2 файлов");

  // 4. Извлекаем именно этот .fb2
  const { files } = extractor.extract({ files: [fb2Header.name] });
  const fileEntry = files?.[0];

  // 5. Берём содержимое из fileEntry.extraction (НЕ extracted)
  const u8 = fileEntry?.extraction; // Uint8Array
  if (!(u8 && u8.byteLength)) {
    throw new Error("Не удалось извлечь .fb2 из RAR");
  }

  // 6. Превращаем его обратно в ArrayBuffer без «хвостов»
  arrayBuffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}



      const xmlText = decodeFB2(arrayBuffer);
      const plainText = parseFB2Text(xmlText);

      const wordsArr = plainText
        .replace(/\s+/g, " ")
        .replace(/[«»]/g, '"')
        .trim()
        .split(/\s+/);

      const newBook = {
        title: file.name.replace(/\.(fb2|zip|rar)$/i, ""),
        words: wordsArr,
        progress: 0,
        createdAt: new Date().toISOString(),
      };

      await db.put(STORES.BOOKS, newBook);
      const updated = await db.getAll(STORES.BOOKS);
      setBooks(updated);
      alert("Книга добавлена.");
    } catch (e) {
      console.error(e);
      alert("Ошибка при загрузке книги: " + e.message);
    }
  }, []);

  const handleOpenBook = useCallback(
    (book) => {
      setCurrentBook(book);
      setWords(book.words || []);
      resetPosition();
      if (book.progress) {
        jumpToPosition(book.progress);
      }
      setPhase(PHASES.READING);
    },
    [jumpToPosition, resetPosition]
  );

  const handleDeleteBook = useCallback(
    async (bookId) => {
      if (!bookId) return;
      if (window.confirm("Удалить книгу безвозвратно?")) {
        try {
          await db.delete(STORES.BOOKS, bookId);
          const all = await db.getAll(STORES.BOOKS);
          setBooks(all);
          if (currentBook?.id === bookId) {
            setCurrentBook(null);
            setWords([]);
            setPhase(PHASES.BOOKS);
          }
        } catch (e) {
          alert("Не удалось удалить книгу: " + e.message);
        }
      }
    },
    [currentBook]
  );

  const handleBackFromReader = useCallback(async () => {
    if (currentBook) {
      const updated = { ...currentBook, progress: position };
      try {
        await db.put(STORES.BOOKS, updated);
        setBooks((arr) => arr.map((b) => (b.id === updated.id ? updated : b)));
      } catch (e) {
        console.error("Не удалось сохранить позицию:", e);
      }
    }
    setPhase(PHASES.BOOKS);
  }, [currentBook, position]);

  const handleSeek = useCallback(
    (newPos) => {
      setIsPlaying(false);
      // в режиме «угол зрения» нормализуем к началу пары
      if (isPeripheral) {
        const base = newPos - (newPos % 2);
        jumpToPosition(base);
      } else {
        jumpToPosition(newPos);
      }
    },
    [jumpToPosition, setIsPlaying, isPeripheral]
  );

  /* ---------- Рендер ---------- */
  if (phase === PHASES.BOOKS) {
    return (
      <BooksView
        books={books}
        onFileUpload={handleFileUpload}
        onOpenBook={handleOpenBook}
        onDeleteBook={handleDeleteBook}
        isDark={isDark}
        toggleTheme={toggleTheme}
      />
    );
  }

  if (phase === PHASES.READING) {
    const progressPercent =
      words.length > 0
        ? (Math.round(((position / words.length) * 100) / 0.2) * 0.2).toFixed(2)
        : 0;

    return (
      <ReadingView
        onBack={handleBackFromReader}
        onSeek={handleSeek}
        isDark={isDark}
        toggleTheme={toggleTheme}
        readerProps={{
          displayedText,
          isPlaying,
          togglePlay,
          wpm,
          setWpm,
          charLimit,
          setCharLimit,
          fontSize,
          setFontSize,
          isBold,
          setIsBold,
          position,
          wordsLength: words.length,
          progressPercent,
          isUpsideDown,
          setIsUpsideDown,
          hideVowels,
          setHideVowels,
          halfVisible,
          setHalfVisible,
          // Новое
          isPeripheral,
          setIsPeripheral,
          peripheralGap,
          setPeripheralGap,
          words,
          setIsPlaying,
          jumpToPosition,
        }}
      />
    );
  }

  return null;
}
