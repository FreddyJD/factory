import { useRef, useState, type ClipboardEvent } from "react";

export interface IssueImage {
  name: string;
  dataUrl: string;
}

const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;

export function useIssueImages() {
  const [images, setImages] = useState<IssueImage[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  async function add(files: File[]) {
    if (pending.current || !files.length) return;
    pending.current = true;
    setReading(true);
    setError("");
    try {
      if (images.length + files.length > 4)
        throw Error("Attach at most 4 images per message.");
      if (
        files.some((file) => !["image/png", "image/jpeg"].includes(file.type))
      )
        throw Error("Use PNG or JPEG images.");
      if (files.some((file) => !file.size || file.size > MAX_FILE))
        throw Error("Each image must be nonempty and at most 2 MiB.");
      const existing = images.reduce((sum, image) => {
        const encoded = image.dataUrl.split(",")[1] ?? "";
        return (
          sum +
          (encoded.length * 3) / 4 -
          (encoded.match(/=+$/)?.[0].length ?? 0)
        );
      }, 0);
      if (
        existing + files.reduce((sum, file) => sum + file.size, 0) >
        MAX_TOTAL
      )
        throw Error("Images must total at most 4 MiB per message.");
      const added = await Promise.all(
        files.map(
          (file) =>
            new Promise<IssueImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  name: file.name || "Pasted image.png",
                  dataUrl: String(reader.result),
                });
              reader.onerror = () =>
                reject(Error(`Could not read ${file.name}.`));
              reader.onabort = () =>
                reject(Error(`Reading ${file.name} was cancelled.`));
              reader.readAsDataURL(file);
            }),
        ),
      );
      setImages((current) => [...current, ...added]);
    } catch (error) {
      setError(String(error));
    } finally {
      pending.current = false;
      setReading(false);
    }
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    void add(files);
  }

  return {
    images,
    reading,
    error,
    add,
    paste,
    clear: () => setImages([]),
    remove: (index: number) =>
      setImages((current) => current.filter((_, i) => i !== index)),
  };
}

export function ImageGallery({
  images,
  remove,
  disabled = false,
}: {
  images: IssueImage[];
  remove?: (index: number) => void;
  disabled?: boolean;
}) {
  if (!images.length) return null;
  return (
    <div className="issue-images">
      {images.map((image, index) => (
        <figure key={index}>
          <a
            href={image.dataUrl}
            download={image.name}
            title={`Download ${image.name}`}
          >
            <img src={image.dataUrl} alt={image.name} loading="lazy" />
          </a>
          <figcaption>{image.name}</figcaption>
          {remove && (
            <button
              type="button"
              className="link-button"
              disabled={disabled}
              aria-label={`Remove ${image.name}`}
              onClick={() => remove(index)}
            >
              Remove
            </button>
          )}
        </figure>
      ))}
    </div>
  );
}

export function ImageAttachments({
  attachments,
  disabled = false,
}: {
  attachments: ReturnType<typeof useIssueImages>;
  disabled?: boolean;
}) {
  return (
    <>
      <ImageGallery
        images={attachments.images}
        remove={attachments.remove}
        disabled={disabled || attachments.reading}
      />
      <label className="image-picker">
        Attach images
        <input
          type="file"
          aria-label="Attach images"
          accept="image/png,image/jpeg"
          multiple
          disabled={disabled || attachments.reading}
          onChange={(event) => {
            void attachments.add(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </label>
      <p className="muted image-help">
        Paste or attach PNG/JPEG images. Up to 4, 2 MiB each, 4 MiB total;
        maximum 2048 pixels per side. Use a model that supports images.
      </p>
      {attachments.reading && <p role="status">Reading images...</p>}
      {attachments.error && (
        <p role="alert" className="text-danger">
          {attachments.error}
        </p>
      )}
    </>
  );
}
