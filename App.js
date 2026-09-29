import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, SafeAreaView, StatusBar, Image, ScrollView,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

// Colours taken from the Sri Lankan flag
const C = {
  maroon: '#8D153A',
  saffron: '#F7B718',
  green: '#00534E',
  orange: '#E57200',
  ink: '#1D1D22',
  grey: '#6B6B75',
  line: '#ECE9EE',
  bg: '#FFFFFF',
};

// Each language gets one flag colour
const LANG_COLOR = { English: C.green, Sinhala: C.maroon, Tamil: C.orange };

// News sources (public RSS feeds)
const SOURCES = [
  // English
  { name: 'Ada Derana', lang: 'English', url: 'https://www.adaderana.lk/rss.php' },
  { name: 'Daily Mirror', lang: 'English', url: 'https://www.dailymirror.lk/rss/breaking_news/108' },
  { name: 'The Island', lang: 'English', url: 'https://island.lk/feed/' },
  { name: 'EconomyNext', lang: 'English', url: 'https://economynext.com/feed/' },
  // Sinhala
  { name: 'Lankadeepa', lang: 'Sinhala', url: 'https://www.lankadeepa.lk/rss/latest_news/1' },
  { name: 'Vikalpa', lang: 'Sinhala', url: 'https://www.vikalpa.org/feed' },
  // Tamil
  { name: 'News21', lang: 'Tamil', url: 'https://www.news21.lk/rss/category/sri-lanka-tamil-news' },
];

const FILTERS = ['All', 'English', 'Tamil', 'Sinhala', 'Saved'];
const SAVED_KEY = 'saved-stories';

// ---------- Reading the RSS feeds ----------

function clean(text = '') {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? clean(match[1]) : '';
}

// Finds the story's photo, wherever the feed keeps it
function findImage(block = '') {
  const patterns = [
    /<media:content[^>]+url=["']([^"']+)["']/i,
    /<media:thumbnail[^>]+url=["']([^"']+)["']/i,
    /<enclosure[^>]+url=["']([^"']+\.(?:jpe?g|png|webp|gif)[^"']*)["']/i,
    /<enclosure[^>]+type=["']image[^>]+url=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["']/i,
    /&lt;img[^&]+src=(?:&quot;|["'])([^"'&]+)/i,
  ];
  for (const p of patterns) {
    const m = block.match(p);
    if (m) return m[1].replace(/&amp;/g, '&').replace(/^http:\/\//, 'https://');
  }
  return null;
}

function parseFeed(xml, source) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.slice(0, 20).map((block) => {
    const date = new Date(getTag(block, 'pubDate'));
    const preview = getTag(block, 'description');
    return {
      id: getTag(block, 'link') || getTag(block, 'guid'),
      title: getTag(block, 'title'),
      link: getTag(block, 'link'),
      preview: preview.length > 140 ? preview.slice(0, 140) + '…' : preview,
      image: findImage(block),
      time: fixTime(date),
      source: source.name,
      lang: source.lang,
    };
  }).filter((item) => item.title && item.link);
}

// Gives up after `ms` milliseconds, even if the site keeps the connection open
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('too slow')), ms)),
  ]);
}

// Downloads a page as text, including the whole body, within 8 seconds
function fetchText(url, options = {}) {
  return withTimeout(
    fetch(url, options).then((res) => {
      if (!res.ok) throw new Error('error ' + res.status);
      return res.text();
    }),
    8000
  );
}

// Reads a news site's feed and turns it into a list of stories
async function fetchDirect(source) {
  const xml = await fetchText(source.url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
  });
  const items = parseFeed(xml, source);
  if (!items.length) throw new Error('no stories found');
  return items;
}

// Reads one news site's feed directly from the phone
function fetchSource(source) {
  return fetchDirect(source);
}

// Some sites label Sri Lankan time as if it were world time (GMT),
// which puts their stories 5.5 hours in the future. This corrects that.
function fixTime(date) {
  if (isNaN(date)) return 0;
  let t = date.getTime();
  const now = Date.now();
  if (t > now + 5 * 60000 && t < now + 6 * 3600000) t -= 5.5 * 3600000;
  return Math.min(t, now);
}

function timeAgo(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// ---------- The app ----------

// A story photo that quietly disappears if it can't load
function StoryPhoto({ uri }) {
  const [failed, setFailed] = useState(false);
  if (!uri || failed) return null;
  return (
    <Image
      source={{ uri }}
      style={styles.photo}
      resizeMode="cover"
      onError={() => setFailed(true)}
    />
  );
}

export default function App() {
  const [news, setNews] = useState([]);
  const [filter, setFilter] = useState('All');
  const [saved, setSaved] = useState({}); // stories the reader bookmarked, by id

  // Load saved stories from the phone when the app opens
  useEffect(() => {
    AsyncStorage.getItem(SAVED_KEY)
      .then((json) => json && setSaved(JSON.parse(json)))
      .catch(() => {});
  }, []);

  const toggleSave = (item) => {
    setSaved((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = { ...item, savedAt: Date.now() };
      AsyncStorage.setItem(SAVED_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  // Opens the full story inside the app, with a Done button to come back
  const openStory = (item) => {
    WebBrowser.openBrowserAsync(item.link, {
      controlsColor: C.maroon,
      toolbarColor: C.bg,
      dismissButtonStyle: 'done',
    }).catch(() => {});
  };
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    const failed = [];
    let collected = [];

    const update = () => {
      const unique = [...new Map(collected.map((n) => [n.id, n])).values()];
      unique.sort((a, b) => b.time - a.time);
      setNews(unique);
      // Problems are only shown to you (the developer), not to readers
      if (failed.length) console.log(`Couldn't load:\n${failed.join('\n')}`);
    };

    const jobs = SOURCES.map((source) =>
      fetchSource(source)
        .then((items) => {
          collected = collected.concat(items);
          setLoading(false); // first news has arrived, show the list
        })
        .catch((e) => failed.push(`${source.name}: ${e.message}`))
        .finally(update)
    );

    // Everything is finished after at most about 16 seconds
    return Promise.all(jobs);
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const shown =
    filter === 'All' ? news
    : filter === 'Saved' ? Object.values(saved).sort((a, b) => b.savedAt - a.savedAt)
    : news.filter((n) => n.lang === filter);

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={styles.item}
      onPress={() => openStory(item)}
      activeOpacity={0.6}
    >
      <View style={[styles.stripe, { backgroundColor: LANG_COLOR[item.lang] }]} />
      <View style={styles.itemBody}>
        <View style={styles.metaRow}>
          <Text style={[styles.source, { color: LANG_COLOR[item.lang] }]}>{item.source}</Text>
          <View style={styles.metaRight}>
            <Text style={styles.time}>{timeAgo(item.time)}</Text>
            <TouchableOpacity
              onPress={() => toggleSave(item)}
              hitSlop={12}
              accessibilityLabel={saved[item.id] ? 'Remove from saved' : 'Save story'}
            >
              <Ionicons
                name={saved[item.id] ? 'bookmark' : 'bookmark-outline'}
                size={20}
                color={saved[item.id] ? C.maroon : C.grey}
              />
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.storyRow}>
          <View style={styles.storyText}>
            <Text style={styles.title} numberOfLines={4}>{item.title}</Text>
            {item.preview ? (
              <Text style={styles.preview} numberOfLines={2}>{item.preview}</Text>
            ) : null}
          </View>
          <StoryPhoto uri={item.image} />
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.appName}>Lanka News</Text>
        <Text style={styles.tagline}>News from home, in your language</Text>
        <View style={styles.flagBar}>
          <View style={[styles.flagPart, { backgroundColor: C.green }]} />
          <View style={[styles.flagPart, { backgroundColor: C.orange }]} />
          <View style={[styles.flagPart, { flex: 4, backgroundColor: C.saffron }]} />
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filtersBar}
        contentContainerStyle={styles.filters}
      >
        {FILTERS.map((f) => {
          const active = f === filter;
          const color = LANG_COLOR[f] || C.ink;
          return (
            <TouchableOpacity
              key={f}
              onPress={() => setFilter(f)}
              style={[
                styles.chip,
                { borderColor: color },
                active && { backgroundColor: color },
              ]}
            >
              <View style={styles.chipInner}>
                {f === 'Saved' ? (
                  <Ionicons name="bookmark" size={13} color={active ? '#fff' : color} />
                ) : null}
                <Text style={[styles.chipText, { color: active ? '#fff' : color }]}>{f}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={C.maroon} />
          <Text style={styles.centerText}>Loading today's news…</Text>
        </View>
      ) : (
        <FlatList
          data={shown}
          style={{ backgroundColor: C.bg }}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.maroon} />
          }
          ListEmptyComponent={
            <Text style={styles.centerText}>
              {filter === 'Saved'
                ? 'No saved stories yet. Tap the bookmark on any story to keep it here.'
                : `No ${filter === 'All' ? '' : filter + ' '}news loaded. Pull down to try again.`}
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.maroon },
  header: { backgroundColor: C.maroon, paddingHorizontal: 20, paddingTop: 16 },
  appName: { color: '#fff', fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  tagline: { color: C.saffron, fontSize: 15, marginTop: 2, marginBottom: 16 },
  flagBar: { flexDirection: 'row', height: 5, marginHorizontal: -20 },
  flagPart: { flex: 1 },
  filtersBar: {
    flexGrow: 0, flexShrink: 0, backgroundColor: C.bg,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14 },
  chipInner: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chip: { borderWidth: 1.5, borderRadius: 20, paddingVertical: 6, paddingHorizontal: 14 },
  chipText: { fontSize: 14, fontWeight: '600' },
  item: {
    flexDirection: 'row', backgroundColor: C.bg,
    borderBottomWidth: 1, borderBottomColor: C.line,
  },
  stripe: { width: 4 },
  itemBody: { flex: 1, paddingVertical: 14, paddingHorizontal: 16 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  source: { fontSize: 13, fontWeight: '700' },
  time: { fontSize: 13, color: C.grey },
  title: { fontSize: 17, lineHeight: 23, fontWeight: '600', color: C.ink },
  preview: { fontSize: 14, lineHeight: 20, color: C.grey, marginTop: 4 },
  storyRow: { flexDirection: 'row', alignItems: 'flex-start' },
  storyText: { flex: 1 },
  photo: {
    width: 92, height: 92, borderRadius: 8, marginLeft: 12, marginTop: 2,
    backgroundColor: C.line,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  centerText: { color: C.grey, fontSize: 15, textAlign: 'center', padding: 24, backgroundColor: C.bg },
});