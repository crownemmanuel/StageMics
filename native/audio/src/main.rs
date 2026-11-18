//! StageMics audio helper: reads channels of an audio input device (the Dante Virtual Soundcard) and
//! streams them to the StageMics service over stdout. The service owns everything else (meters, the
//! recorder, files); this program only captures, so a driver problem can never take the service down.
//!
//!   stagemics-audio list
//!       One JSON line: {"host": "CoreAudio", "devices": [{"name", "channels", "rates", "defaultRate", "default"}]}
//!   stagemics-audio capture --device "<name>" [--rate 48000 | 0 = the device's own] --channels 1,2,5-8
//!       Binary packets on stdout until stdin closes (the service went away) or the device fails (exit 3).
//!
//! Packet (little-endian): u32 magic "SMA1", u32 kind, u32 a, u32 b, then the payload.
//!   kind 1 audio  a = frames, b = channels; payload frames × channels f32, interleaved in --channels order
//!   kind 2 gap    a = frames lost (the service was too slow to read and the buffer overflowed), b = 0
//!   kind 3 info   a = JSON byte length, b = 0; payload {"device", "rate", "deviceChannels", "channels", "format", "host"}
//! Messages for people go to stderr.
//!
//! The audio callback never blocks or allocates in steady state: it copies the wanted channels into a
//! lock-free ring (about 5 s deep); a writer thread empties it onto stdout.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::cell::UnsafeCell;
use std::io::{BufWriter, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

const MAGIC: u32 = 0x3141_4D53; // "SMA1"
const KIND_AUDIO: u32 = 1;
const KIND_GAP: u32 = 2;
const KIND_INFO: u32 = 3;
/// Frames per audio packet at most (10 ms at 48 kHz).
const CHUNK_FRAMES: usize = 480;
const RING_SECONDS: usize = 5;

fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let code = match args.first().map(String::as_str) {
    Some("list") => list(),
    Some("capture") => capture(&args[1..]),
    Some("--version") => {
      println!("stagemics-audio {}", env!("CARGO_PKG_VERSION"));
      0
    }
    _ => {
      eprintln!("usage: stagemics-audio list | capture --device <name> [--rate <hz>] --channels 1,2,5-8");
      2
    }
  };
  std::process::exit(code);
}

// ---------------------------------------------------------------- list

fn list() -> i32 {
  let host = cpal::default_host();
  let default_name = host.default_input_device().and_then(|d| d.name().ok());
  let mut items = Vec::new();
  let devices = match host.input_devices() {
    Ok(d) => d,
    Err(e) => {
      eprintln!("cannot list input devices: {e}");
      return 3;
    }
  };
  for d in devices {
    let Ok(name) = d.name() else { continue };
    let mut channels = 0u16;
    let mut rates: Vec<u32> = Vec::new();
    if let Ok(cfgs) = d.supported_input_configs() {
      for c in cfgs {
        channels = channels.max(c.channels());
        for r in [44_100, 48_000, 88_200, 96_000] {
          if c.min_sample_rate().0 <= r && r <= c.max_sample_rate().0 && !rates.contains(&r) {
            rates.push(r);
          }
        }
      }
    }
    rates.sort();
    let default_rate = d.default_input_config().map(|c| c.sample_rate().0).unwrap_or(0);
    items.push(format!(
      "{{\"name\":{},\"channels\":{},\"rates\":[{}],\"defaultRate\":{},\"default\":{}}}",
      json_str(&name),
      channels,
      rates.iter().map(|r| r.to_string()).collect::<Vec<_>>().join(","),
      default_rate,
      default_name.as_deref() == Some(name.as_str())
    ));
  }
  println!("{{\"host\":{},\"devices\":[{}]}}", json_str(host.id().name()), items.join(","));
  0
}

// ---------------------------------------------------------------- capture

struct Shared {
  /// Interleaved samples of the wanted channels.
  ring: Ring<f32>,
  /// Overflows as (frame position, frames lost) pairs, in order.
  gaps: Ring<u64>,
  failed: AtomicBool,
}

fn capture(args: &[String]) -> i32 {
  let mut device_name = String::new();
  let mut rate: u32 = 0;
  let mut channels_arg = String::new();
  let mut i = 0;
  while i < args.len() {
    let v = args.get(i + 1).cloned().unwrap_or_default();
    match args[i].as_str() {
      "--device" => device_name = v,
      "--rate" => rate = v.parse().unwrap_or(0),
      "--channels" => channels_arg = v,
      other => {
        eprintln!("unknown option {other}");
        return 2;
      }
    }
    i += 2;
  }
  let wanted = match parse_channels(&channels_arg) {
    Some(w) if !w.is_empty() => w,
    _ => {
      eprintln!("--channels is required, e.g. 1,2,5-8 (1-based device channels)");
      return 2;
    }
  };
  let need = *wanted.iter().max().unwrap() as u16;

  let host = cpal::default_host();
  let Some(device) = find_device(&host, &device_name) else {
    eprintln!("no input device named \"{device_name}\"");
    return 2;
  };
  let name = device.name().unwrap_or_default();
  let Some(config) = pick_config(&device, need, rate) else {
    let have = device.supported_input_configs().map(|c| c.map(|x| x.channels()).max().unwrap_or(0)).unwrap_or(0);
    eprintln!("\"{name}\" cannot give {need} channels{} (it has {have})", if rate > 0 { format!(" at {rate} Hz") } else { String::new() });
    return 2;
  };
  let dev_ch = config.channels() as usize;
  let sr = config.sample_rate().0;
  let format = config.sample_format();
  let stream_config: cpal::StreamConfig = config.into();
  let sel = wanted.len();
  let shared = Arc::new(Shared {
    ring: Ring::new((sr as usize * RING_SECONDS * sel).next_power_of_two()),
    gaps: Ring::new(4096),
    failed: AtomicBool::new(false),
  });

  let idx: Vec<usize> = wanted.iter().map(|c| c - 1).collect();
  let built = match format {
    cpal::SampleFormat::F32 => build::<f32>(&device, &stream_config, dev_ch, idx, shared.clone(), |x| x),
    cpal::SampleFormat::I32 => build::<i32>(&device, &stream_config, dev_ch, idx, shared.clone(), |x| x as f32 / 2_147_483_648.0),
    cpal::SampleFormat::I16 => build::<i16>(&device, &stream_config, dev_ch, idx, shared.clone(), |x| x as f32 / 32_768.0),
    cpal::SampleFormat::U16 => build::<u16>(&device, &stream_config, dev_ch, idx, shared.clone(), |x| (x as f32 - 32_768.0) / 32_768.0),
    cpal::SampleFormat::F64 => build::<f64>(&device, &stream_config, dev_ch, idx, shared.clone(), |x| x as f32),
    other => {
      eprintln!("sample format {other:?} is not supported");
      return 3;
    }
  };
  let stream = match built {
    Ok(s) => s,
    Err(e) => {
      eprintln!("cannot open \"{name}\": {e}");
      return 3;
    }
  };
  if let Err(e) = stream.play() {
    eprintln!("cannot start \"{name}\": {e}");
    return 3;
  }
  eprintln!("capturing {sel} of {dev_ch} channels from \"{name}\" at {sr} Hz ({format:?})");

  // The service closing our stdin means it went away: stop with it.
  std::thread::spawn(|| {
    let mut sink = [0u8; 256];
    let mut stdin = std::io::stdin();
    while let Ok(n) = stdin.read(&mut sink) {
      if n == 0 {
        break;
      }
    }
    std::process::exit(0);
  });

  let mut out = BufWriter::with_capacity(1 << 18, std::io::stdout().lock());
  let info = format!(
    "{{\"device\":{},\"rate\":{},\"deviceChannels\":{},\"channels\":[{}],\"format\":{},\"host\":{}}}",
    json_str(&name),
    sr,
    dev_ch,
    wanted.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(","),
    json_str(&format!("{format:?}")),
    json_str(host.id().name())
  );
  if write_packet(&mut out, KIND_INFO, info.len() as u32, 0, info.as_bytes()).is_err() || out.flush().is_err() {
    return 0;
  }

  let mut read_frames: u64 = 0;
  let mut samples = vec![0f32; CHUNK_FRAMES * sel];
  let mut bytes: Vec<u8> = Vec::with_capacity(CHUNK_FRAMES * sel * 4);
  let mut gap = [0u64; 2];
  loop {
    if shared.failed.load(Ordering::Acquire) {
      let _ = out.flush();
      drop(stream);
      return 3;
    }
    let next_gap = if shared.gaps.peek_into(&mut gap) == 2 { Some((gap[0], gap[1])) } else { None };
    if let Some((pos, lost)) = next_gap {
      if pos <= read_frames {
        if write_packet(&mut out, KIND_GAP, lost as u32, 0, &[]).is_err() {
          return 0;
        }
        shared.gaps.skip(2);
        continue;
      }
    }
    let mut take = (shared.ring.len() / sel).min(CHUNK_FRAMES);
    if let Some((pos, _)) = next_gap {
      take = take.min((pos - read_frames) as usize);
    }
    if take == 0 {
      if out.flush().is_err() {
        return 0;
      }
      std::thread::sleep(Duration::from_millis(2));
      continue;
    }
    let n = shared.ring.pop_into(&mut samples[..take * sel]);
    debug_assert_eq!(n, take * sel);
    bytes.clear();
    for x in &samples[..n] {
      bytes.extend_from_slice(&x.to_le_bytes());
    }
    if write_packet(&mut out, KIND_AUDIO, take as u32, sel as u32, &bytes).is_err() {
      return 0;
    }
    read_frames += take as u64;
  }
}

fn build<T: cpal::SizedSample + Send + 'static>(
  device: &cpal::Device,
  config: &cpal::StreamConfig,
  dev_ch: usize,
  idx: Vec<usize>,
  shared: Arc<Shared>,
  conv: fn(T) -> f32,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
  let sel = idx.len();
  let mut scratch: Vec<f32> = vec![0.0; 8192 * sel];
  let mut pushed: u64 = 0;
  let mut lost: u64 = 0;
  let failed = shared.clone();
  device.build_input_stream(
    config,
    move |data: &[T], _: &cpal::InputCallbackInfo| {
      let frames = data.len() / dev_ch;
      if scratch.len() < frames * sel {
        scratch.resize(frames * sel, 0.0);
      }
      for f in 0..frames {
        let src = &data[f * dev_ch..(f + 1) * dev_ch];
        for (k, &c) in idx.iter().enumerate() {
          let v = conv(src[c]);
          scratch[f * sel + k] = if v.is_finite() { v } else { 0.0 };
        }
      }
      if lost > 0 && shared.gaps.push_slice(&[pushed, lost]) {
        lost = 0;
      }
      if lost == 0 && shared.ring.push_slice(&scratch[..frames * sel]) {
        pushed += frames as u64;
      } else {
        lost += frames as u64;
      }
    },
    move |e| {
      eprintln!("device error: {e}");
      failed.failed.store(true, Ordering::Release);
    },
    None,
  )
}

/// The device the service named: exact name first, then a case-insensitive part of it.
fn find_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
  let all: Vec<cpal::Device> = host.input_devices().ok()?.collect();
  let lower = name.to_lowercase();
  let mut exact = None;
  let mut partial = None;
  for d in all {
    let n = d.name().unwrap_or_default();
    if n == name {
      exact = Some(d);
      break;
    }
    if partial.is_none() && !lower.is_empty() && n.to_lowercase().contains(&lower) {
      partial = Some(d);
    }
  }
  exact.or(partial)
}

/// The device's own format when it has enough channels (so we never change the Dante clock), else the
/// closest supported one. `rate` 0 = whatever the device runs at.
fn pick_config(device: &cpal::Device, need: u16, rate: u32) -> Option<cpal::SupportedStreamConfig> {
  if let Ok(d) = device.default_input_config() {
    if d.channels() >= need && (rate == 0 || d.sample_rate().0 == rate) {
      return Some(d);
    }
  }
  let rank = |f: cpal::SampleFormat| match f {
    cpal::SampleFormat::F32 => 0,
    cpal::SampleFormat::I32 => 1,
    cpal::SampleFormat::I16 => 2,
    _ => 3,
  };
  let want_rate = if rate > 0 { rate } else { device.default_input_config().map(|c| c.sample_rate().0).unwrap_or(48_000) };
  device
    .supported_input_configs()
    .ok()?
    .filter(|c| c.channels() >= need && c.min_sample_rate().0 <= want_rate && want_rate <= c.max_sample_rate().0)
    .min_by_key(|c| (rank(c.sample_format()), c.channels()))
    .map(|c| c.with_sample_rate(cpal::SampleRate(want_rate)))
}

fn parse_channels(s: &str) -> Option<Vec<usize>> {
  let mut out = Vec::new();
  for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
    if let Some((a, b)) = part.split_once('-') {
      let (a, b): (usize, usize) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
      if a == 0 || b < a || b > 512 {
        return None;
      }
      out.extend(a..=b);
    } else {
      let c: usize = part.parse().ok()?;
      if c == 0 || c > 512 {
        return None;
      }
      out.push(c);
    }
  }
  Some(out)
}

fn write_packet(out: &mut impl Write, kind: u32, a: u32, b: u32, payload: &[u8]) -> std::io::Result<()> {
  let mut head = [0u8; 16];
  head[0..4].copy_from_slice(&MAGIC.to_le_bytes());
  head[4..8].copy_from_slice(&kind.to_le_bytes());
  head[8..12].copy_from_slice(&a.to_le_bytes());
  head[12..16].copy_from_slice(&b.to_le_bytes());
  out.write_all(&head)?;
  out.write_all(payload)
}

fn json_str(s: &str) -> String {
  let mut o = String::with_capacity(s.len() + 2);
  o.push('"');
  for ch in s.chars() {
    match ch {
      '"' => o.push_str("\\\""),
      '\\' => o.push_str("\\\\"),
      c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
      c => o.push(c),
    }
  }
  o.push('"');
  o
}

// ---------------------------------------------------------------- single-producer single-consumer ring

/// Lock-free ring for one writer (the audio callback) and one reader (the writer thread).
/// `write` and `read` only grow; the slot is the index masked by the power-of-two capacity.
struct Ring<T> {
  buf: Box<[UnsafeCell<T>]>,
  mask: usize,
  write: AtomicUsize,
  read: AtomicUsize,
}

unsafe impl<T: Send> Sync for Ring<T> {}

impl<T: Copy + Default> Ring<T> {
  fn new(cap: usize) -> Self {
    let cap = cap.next_power_of_two();
    Ring { buf: (0..cap).map(|_| UnsafeCell::new(T::default())).collect(), mask: cap - 1, write: AtomicUsize::new(0), read: AtomicUsize::new(0) }
  }

  fn len(&self) -> usize {
    self.write.load(Ordering::Acquire) - self.read.load(Ordering::Acquire)
  }

  /// All or nothing (so frames are never split).
  fn push_slice(&self, data: &[T]) -> bool {
    let w = self.write.load(Ordering::Relaxed);
    let r = self.read.load(Ordering::Acquire);
    if self.mask + 1 - (w - r) < data.len() {
      return false;
    }
    for (i, x) in data.iter().enumerate() {
      unsafe { *self.buf[(w + i) & self.mask].get() = *x };
    }
    self.write.store(w + data.len(), Ordering::Release);
    true
  }

  fn peek_into(&self, out: &mut [T]) -> usize {
    let r = self.read.load(Ordering::Relaxed);
    let n = (self.write.load(Ordering::Acquire) - r).min(out.len());
    for (i, o) in out.iter_mut().take(n).enumerate() {
      *o = unsafe { *self.buf[(r + i) & self.mask].get() };
    }
    n
  }

  fn skip(&self, n: usize) {
    let r = self.read.load(Ordering::Relaxed);
    self.read.store(r + n.min(self.write.load(Ordering::Acquire) - r), Ordering::Release);
  }

  fn pop_into(&self, out: &mut [T]) -> usize {
    let n = self.peek_into(out);
    self.skip(n);
    n
  }
}
