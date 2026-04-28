import { FC, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import dayjs from "dayjs";
import toast from "react-hot-toast";

import MicOnIcon from "@/assets/icons/mic.on.svg";
import DeleteIcon from "@/assets/icons/delete.svg";
import SendIcon from "@/assets/icons/send.svg";
import useUploadFile from "@/hooks/useUploadFile";
import useSendMessage from "@/hooks/useSendMessage";
import { useAppSelector } from "@/app/store";
import { ChatContext } from "@/types/common";
import Tooltip from "../Tooltip";

const MAX_DURATION_SEC = 60 * 5; // 5 minutes safety cap

// Pick the best mime type supported by the current browser.
// Order matters: prefer Opus (smaller/better) when available, fall back to MP4/AAC for Safari.
function pickMimeType(): { mime: string; ext: string } | null {
  const candidates: { mime: string; ext: string }[] = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/mpeg", ext: "mp3" },
  ];
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      /* ignore */
    }
  }
  return { mime: "", ext: "webm" };
}

type Props = {
  context: ChatContext;
  to: number;
};

const VoiceRecorder: FC<Props> = ({ context, to }) => {
  const { t } = useTranslation();
  const from_uid = useAppSelector((store) => store.authData.user?.uid);
  const { uploadFile } = useUploadFile({ context, id: to });
  const { sendMessage } = useSendMessage({ context, from: from_uid, to });

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const mimeRef = useRef<{ mime: string; ext: string } | null>(null);

  const cleanupStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      // Stop everything if component unmounts mid-recording.
      cancelledRef.current = true;
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      cleanupStream();
    };
  }, []);

  const startRecording = async () => {
    if (recording || busy) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Microphone is not available in this browser");
      return;
    }
    const picked = pickMimeType();
    if (!picked) {
      toast.error("Audio recording is not supported in this browser");
      return;
    }
    mimeRef.current = picked;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error(e);
      toast.error("Microphone permission denied");
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    cancelledRef.current = false;

    let recorder: MediaRecorder;
    try {
      recorder = picked.mime
        ? new MediaRecorder(stream, { mimeType: picked.mime })
        : new MediaRecorder(stream);
    } catch (e) {
      console.error(e);
      toast.error("Failed to start recorder");
      cleanupStream();
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) chunksRef.current.push(evt.data);
    };

    recorder.onstop = async () => {
      const wasCancelled = cancelledRef.current;
      const collected = chunksRef.current;
      chunksRef.current = [];
      cleanupStream();
      setRecording(false);
      setElapsed(0);
      if (wasCancelled) return;
      if (collected.length === 0) {
        toast.error("No audio captured");
        return;
      }
      const mime = picked.mime || collected[0].type || "audio/webm";
      const blob = new Blob(collected, { type: mime });
      if (blob.size < 100) {
        toast.error("Recording too short");
        return;
      }
      const ext = picked.ext;
      const ts = +new Date();
      const filename = `voice-${ts}.${ext}`;
      const file = new File([blob], filename, { type: mime });

      setBusy(true);
      try {
        const result = await uploadFile(file);
        if (!result) {
          toast.error("Upload failed");
          return;
        }
        await sendMessage({
          type: "audio",
          content: { path: result.path },
          properties: {
            content_type: mime,
            name: filename,
            size: blob.size,
            local_id: ts,
          },
        });
      } catch (e) {
        console.error(e);
        toast.error("Failed to send voice message");
      } finally {
        setBusy(false);
      }
    };

    recorder.start();
    setRecording(true);
    setElapsed(0);
    timerRef.current = window.setInterval(() => {
      setElapsed((prev) => {
        const next = prev + 1;
        if (next >= MAX_DURATION_SEC) {
          // auto-stop and send
          try {
            recorderRef.current?.stop();
          } catch {
            /* ignore */
          }
        }
        return next;
      });
    }, 1000);
  };

  const stopAndSend = () => {
    if (!recording) return;
    cancelledRef.current = false;
    try {
      recorderRef.current?.stop();
    } catch (e) {
      console.error(e);
    }
  };

  const cancelRecording = () => {
    if (!recording) return;
    cancelledRef.current = true;
    try {
      recorderRef.current?.stop();
    } catch (e) {
      console.error(e);
    }
  };

  if (recording) {
    const display = dayjs.duration(elapsed, "seconds").format("mm:ss");
    return (
      <div className="flex items-center gap-2 px-2 py-1 rounded bg-red-50 dark:bg-red-900/30">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
        </span>
        <span className="text-xs tabular-nums text-red-600 dark:text-red-300">{display}</span>
        <Tooltip placement="top" tip="Cancel">
          <DeleteIcon
            className={clsx("w-5 h-5 cursor-pointer fill-red-500")}
            onClick={cancelRecording}
          />
        </Tooltip>
        <Tooltip placement="top" tip="Send">
          <SendIcon
            className={clsx("w-5 h-5 cursor-pointer fill-primary-500")}
            onClick={stopAndSend}
          />
        </Tooltip>
      </div>
    );
  }

  return (
    <Tooltip placement="top" tip={busy ? "Sending..." : t("action.record_voice", "Record voice")}>
      <button
        type="button"
        disabled={busy}
        onClick={startRecording}
        className="cursor-pointer disabled:opacity-50"
      >
        <MicOnIcon className="w-6 h-6 dark:fill-gray-300" />
      </button>
    </Tooltip>
  );
};

export default VoiceRecorder;
