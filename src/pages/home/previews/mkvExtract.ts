import { Decoder, tools } from "ebml";

// 定义 Subtitle 接口
interface Subtitle {
    name: string;
    url: string;
}

function mkvExtract(file: File, callback: (error: Error | null, files?: { name: string, data: any }[]) => void) {
    createFileStream(file)
        .then((stream) => handleStream(stream, callback))
        .catch((error) => callback(error));
}

function createFileStream(file: File): Promise<ReadableStream<Uint8Array>> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const buffer = reader.result as ArrayBuffer;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(buffer));
                    controller.close();
                }
            });
            resolve(stream);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

function handleStream(stream: ReadableStream<Uint8Array>, callback: (error: Error | null, files?: { name: string, data: any }[]) => void) {
    const decoder = new Decoder();
    const tracks: number[] = [];
    const trackData: any[][] = [];
    const files: { name: string, data: any }[] = [];
    let currentFile = 0;
    let currentTimecode: number | undefined;
    let trackIndexTemp: number | undefined;
    let trackTypeTemp: number | undefined;
    let trackDataTemp: string | undefined;
    let trackIndex: number | undefined;

    const reader = stream.getReader();

    function read() {
        reader.read().then(({ done, value }) => {
            if (done) {
                processTracks();
                return;
            }

            decoder.write(value);

            read();
        }).catch(error => {
            callback(error);
        });
    }

    decoder.on("error", (error) => {
        callback(error);
    });

    decoder.on("data", (chunk) => {
        switch (chunk[0]) {
            case "end":
                if (chunk[1].name === "TrackEntry") {
                    if (trackTypeTemp === 0x11) {
                        tracks.push(trackIndexTemp!);
                        trackData.push([trackDataTemp]);
                    }
                }
                break;
            case "tag":
                if (chunk[1].name === "FileName") {
                    if (!files[currentFile]) files[currentFile] = {} as any;
                    files[currentFile].name = chunk[1].data.toString();
                }
                if (chunk[1].name === "FileData") {
                    if (!files[currentFile]) files[currentFile] = {} as any;
                    files[currentFile].data = chunk[1].data;
                }
                if (chunk[1].name === "TrackNumber") {
                    trackIndexTemp = chunk[1].data[0];
                }
                if (chunk[1].name === "TrackType") {
                    trackTypeTemp = chunk[1].data[0];
                }
                if (chunk[1].name === "CodecPrivate") {
                    trackDataTemp = chunk[1].data.toString();
                }
                if (chunk[1].name === "SimpleBlock" || chunk[1].name === "Block") {
                    const trackLength = tools.readVint(chunk[1].data);
                    trackIndex = tracks.indexOf(trackLength.value);
                    if (trackIndex !== -1) {
                        const timestampArray = new Uint8Array(chunk[1].data).slice(
                            trackLength.length,
                            trackLength.length + 2
                        );
                        const timestamp = new DataView(timestampArray.buffer).getInt16(0);
                        const lineData = chunk[1].data.slice(trackLength.length + 3);
                        trackData[trackIndex].push(
                            lineData.toString(),
                            timestamp,
                            currentTimecode
                        );
                    }
                }
                if (chunk[1].name === "Timecode") {
                    const timecode = readUnsignedInteger(padZeroes(chunk[1].data));
                    currentTimecode = timecode;
                }
                if (chunk[1].name === "BlockDuration" && trackIndex !== -1) {
                    const duration = readUnsignedInteger(padZeroes(chunk[1].data));
                    trackData[trackIndex].push(duration);
                }
                break;
            default:
            // do nothing
        }
        if (files[currentFile] && files[currentFile].name && files[currentFile].data) {
            currentFile++;
        }
    });

    function processTracks() {
        trackData.forEach((entries, index) => {
            const heading = entries[0];
            const isASS = heading.includes("Format:");
            const formatFn = isASS ? formatTimestamp : formatTimestampSRT;
            const eventMatches = isASS
                ? heading.match(/\[Events\]\s+Format:([^\r\n]*)/)
                : [""];
            const headingParts = isASS ? heading.split(eventMatches![0]) : ["", ""];
            const fixedLines: string[] = [];
            for (let i = 1; i < entries.length; i += 4) {
                const line = entries[i];
                const lineTimestamp = entries[i + 1];
                const chunkTimestamp = entries[i + 2];
                const duration = entries[i + 3];
                const lineParts = isASS && line.split(",");
                const lineIndex = isASS ? lineParts![0] : (i - 1) / 4;
                const startTimestamp = formatFn(chunkTimestamp + lineTimestamp);
                const endTimestamp = formatFn(
                    chunkTimestamp + lineTimestamp + duration
                );

                const fixedLine = isASS
                    ? "Dialogue: " +
                    [lineParts![1], startTimestamp, endTimestamp]
                        .concat(lineParts!.slice(2))
                        .join(",")
                    : lineIndex +
                    1 +
                    "\r\n" +
                    startTimestamp.replace(".", ",") +
                    " --> " +
                    endTimestamp.replace(".", ",") +
                    "\r\n" +
                    line +
                    "\r\n";

                if (fixedLines[lineIndex]) {
                    fixedLines[lineIndex] += "\r\n" + fixedLine;
                } else {
                    fixedLines[lineIndex] = fixedLine;
                }
            }
            const data =
                (isASS ? headingParts[0] + eventMatches![0] + "\r\n" : "") +
                fixedLines.join("\r\n") +
                headingParts[1] +
                "\r\n";

            files.push({
                name: "Subtitle_" + (index + 1) + (isASS ? ".ass" : ".srt"),
                data
            });
        });

        if (files.length === 0) {
            callback(Error("No data found"));
            return;
        }

        callback(null, files);
    }

    read();
}

function padZeroes(arr: Uint8Array): ArrayBuffer {
    const len = Math.ceil(arr.length / 2) * 2;
    const output = new Uint8Array(len);
    output.set(arr, len - arr.length);
    return output.buffer;
}

function readUnsignedInteger(data: ArrayBuffer): number {
    const view = new DataView(data);
    return data.byteLength === 2 ? view.getUint16(0) : view.getUint32(0);
}

function formatTimestamp(timestamp: number): string {
    const seconds = timestamp / 1000;
    const hh = Math.floor(seconds / 3600);
    let mm = Math.floor((seconds - hh * 3600) / 60);
    let ss = (seconds - hh * 3600 - mm * 60).toFixed(2);

    if (mm < 10) mm = `0${mm}`;
    if (ss < 10) ss = `0${ss}`;

    return `${hh}:${mm}:${ss}`;
}

function formatTimestampSRT(timestamp: number): string {
    const seconds = timestamp / 1000;
    let hh = Math.floor(seconds / 3600);
    let mm = Math.floor((seconds - hh * 3600) / 60);
    let ss = (seconds - hh * 3600 - mm * 60).toFixed(3);

    if (hh < 10) hh = `0${hh}`;
    if (mm < 10) mm = `0${mm}`;
    if (ss < 10) ss = `0${ss}`;

    return `${hh}:${mm}:${ss}`;
}

export default mkvExtract;
