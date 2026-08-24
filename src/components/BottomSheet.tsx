import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';

type Props = {
  children: ReactNode;
  collapsedHeight: number;
  expandedHeight: number;
  onSnapChange?: (expanded: boolean) => void;
};

export type BottomSheetRef = {
  expand: () => void;
  collapse: () => void;
};

const VELOCITY_THRESHOLD = 0.35;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const BottomSheet = forwardRef<BottomSheetRef, Props>(function BottomSheet(
  { children, collapsedHeight, expandedHeight, onSnapChange },
  ref
) {
  const maxTranslate = expandedHeight - collapsedHeight;
  const translateY = useRef(new Animated.Value(maxTranslate)).current;
  const currentValue = useRef(maxTranslate);
  const gestureStart = useRef(maxTranslate);

  useEffect(() => {
    const id = translateY.addListener(({ value }) => {
      currentValue.current = value;
    });
    return () => translateY.removeListener(id);
  }, [translateY]);

  const snapTo = (target: number) => {
    Animated.spring(translateY, { toValue: target, useNativeDriver: true, bounciness: 4 }).start();
    onSnapChange?.(target === 0);
  };

  useImperativeHandle(ref, () => ({
    expand: () => snapTo(0),
    collapse: () => snapTo(maxTranslate),
  }));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 2,
      onPanResponderGrant: () => {
        gestureStart.current = currentValue.current;
      },
      onPanResponderMove: (_, gesture) => {
        translateY.setValue(clamp(gestureStart.current + gesture.dy, 0, maxTranslate));
      },
      onPanResponderRelease: (_, gesture) => {
        const finalValue = clamp(gestureStart.current + gesture.dy, 0, maxTranslate);
        let target: number;
        if (Math.abs(gesture.vy) > VELOCITY_THRESHOLD) {
          // A deliberate flick snaps in that direction regardless of distance dragged.
          target = gesture.vy < 0 ? 0 : maxTranslate;
        } else {
          target = finalValue > maxTranslate / 2 ? maxTranslate : 0;
        }
        snapTo(target);
      },
    })
  ).current;

  return (
    <Animated.View style={[styles.sheet, { height: expandedHeight, transform: [{ translateY }] }]}>
      <View {...panResponder.panHandlers} style={styles.handleArea}>
        <View style={styles.handle} />
      </View>
      {children}
    </Animated.View>
  );
});

export default BottomSheet;

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  handleArea: { paddingVertical: 14, alignItems: 'center' },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#ddd' },
});
