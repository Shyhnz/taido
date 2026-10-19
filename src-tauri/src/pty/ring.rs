//! Circular output buffer of a terminal: keeps the last `cap` bytes, replayed to
//! the UI when it attaches.

use std::collections::VecDeque;

#[derive(Debug)]
pub struct Ring {
    bytes: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Ring {
            bytes: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
        }
    }

    /// Appends `data`, dropping the oldest bytes beyond the capacity.
    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - self.cap..]);
            return;
        }
        let overflow = (self.bytes.len() + data.len()).saturating_sub(self.cap);
        self.bytes.drain(..overflow);
        self.bytes.extend(data);
    }

    /// Copy of the buffered bytes, oldest first.
    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.bytes.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_under_capacity() {
        let mut r = Ring::new(8);
        r.push(b"abc");
        r.push(b"de");
        assert_eq!(r.snapshot(), b"abcde");
    }

    #[test]
    fn drops_oldest_bytes_beyond_capacity() {
        let mut r = Ring::new(5);
        r.push(b"abcd");
        r.push(b"efg");
        assert_eq!(r.snapshot(), b"cdefg");
        assert_eq!(r.len(), 5);
    }

    #[test]
    fn a_chunk_larger_than_capacity_keeps_its_tail() {
        let mut r = Ring::new(3);
        r.push(b"xy");
        r.push(b"abcdef");
        assert_eq!(r.snapshot(), b"def");
    }
}
